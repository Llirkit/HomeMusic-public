const { app, BrowserWindow, Menu, Notification, dialog, ipcMain, nativeTheme, shell } = require('electron');
const { readFileSync, writeFileSync, mkdirSync, renameSync } = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { APP_ID, CHANNELS, EMPTY_STATE, hubURL, sameOrigin, playerState, thumbbar } = require('./contracts.cjs');
const { transportIcon } = require('./icons.cjs');
const { attachTaskbar } = require('./taskbar.cjs');
const { DesktopUpdates, updateMenu } = require('./updates.cjs');

app.setAppUserModelId(APP_ID);
let mainWindow = null;
let setupWindow = null;
let origin = null;
let state = EMPTY_STATE;
let lastError = '';
let connecting = false;
let autoConnect = false;
let icons;
let taskbar = null;
let playerConnected = false;
let updates = null;
const setupFile = path.join(__dirname, 'setup.html');
const setupURL = pathToFileURL(setupFile).href;
const configPath = () => path.join(app.getPath('userData'), 'config.json');
const appIcon = () => app.isPackaged ? path.join(process.resourcesPath, 'icon.png') : path.join(__dirname, '../../web/public/icons/icon-512.png');

function readConfig() {
  try { return { url: hubURL(JSON.parse(readFileSync(configPath(), 'utf8')).url) }; }
  catch { return { url: '' }; }
}

function saveConfig(url) {
  mkdirSync(app.getPath('userData'), { recursive: true });
  writeFileSync(`${configPath()}.tmp`, JSON.stringify({ url }), 'utf8');
  renameSync(`${configPath()}.tmp`, configPath());
}

function focus(win) {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function updateButtons() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.setTitle(state.active ? `${state.title}${state.artist ? ` — ${state.artist}` : ''} · HomeMusic` : 'HomeMusic');
  taskbar?.update();
}

function resetPlayer() { state = EMPTY_STATE; updateButtons(); }

function sendCommand(command) {
  if (!mainWindow || mainWindow.isDestroyed() || !state.active || !sameOrigin(mainWindow.webContents.getURL(), origin)) return;
  if (command === 'next' && !state.canNext || command === 'previous' && !state.canPrevious) return;
  mainWindow.webContents.send(CHANNELS.command, command);
}

function external(value) {
  try {
    if (['http:', 'https:'].includes(new URL(value).protocol)) void shell.openExternal(value).catch(console.error);
  } catch { /* invalid external link */ }
}

function lockNavigation(win, allowed) {
  const guard = (event, url) => {
    if (!allowed(url)) { event.preventDefault(); external(url); }
  };
  win.webContents.on('will-navigate', guard);
  win.webContents.on('will-redirect', (event, url) => {
    if (!allowed(url)) event.preventDefault();
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    external(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-attach-webview', (event) => event.preventDefault());
}

function showSetup(error = '', automatic = false) {
  lastError = error;
  if (setupWindow && !setupWindow.isDestroyed()) { focus(setupWindow); return; }
  autoConnect = automatic;
  setupWindow = new BrowserWindow({ width: 560, height: 540, minWidth: 480, minHeight: 500,
    title: 'Подключение · HomeMusic', backgroundColor: '#121212', icon: appIcon(),
    webPreferences: { preload: path.join(__dirname, 'setup-preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false } });
  setupWindow.setMenu(null);
  lockNavigation(setupWindow, (url) => url === setupURL);
  setupWindow.on('closed', () => { setupWindow = null; });
  void setupWindow.loadFile(setupFile);
}

function createPlayer(url) {
  origin = url;
  state = EMPTY_STATE;
  playerConnected = false;
  mainWindow = new BrowserWindow({ width: 1280, height: 860, minWidth: 480, minHeight: 540, show: false,
    title: 'HomeMusic', backgroundColor: '#0b0b0b', icon: appIcon(), autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), additionalArguments: [`--homemusic-origin=${url}`],
      contextIsolation: true, sandbox: true, nodeIntegration: false } });
  const win = mainWindow;
  taskbar = process.platform === 'win32' ? attachTaskbar(win, () => thumbbar(state, icons, sendCommand)) : null;
  lockNavigation(win, (value) => sameOrigin(value, origin));
  win.on('page-title-updated', (event) => event.preventDefault());
  win.webContents.on('did-start-navigation', (_event, _url, inPlace, isMainFrame) => {
    if (isMainFrame && !inPlace) { playerConnected = false; resetPlayer(); }
  });
  win.webContents.on('render-process-gone', () => {
    resetPlayer();
    showSetup('Окно приложения было остановлено. Нажмите «Подключиться», чтобы открыть его заново.');
  });
  win.webContents.on('did-fail-load', (_event, code, _description, _url, isMainFrame) => {
    if (isMainFrame && code !== -3 && !connecting) {
      resetPlayer();
      showSetup('Не удалось загрузить Хаб. Проверьте сеть и нажмите «Подключиться», чтобы повторить.');
    }
  });
  win.on('closed', () => { if (mainWindow === win) { mainWindow = null; state = EMPTY_STATE; taskbar = null; } });
  // Electron itself restores native buttons on the Windows TaskbarButtonCreated message.
  win.webContents.on('did-finish-load', updateButtons);
  return win;
}

async function connect(value) {
  if (connecting) return { error: 'Подключение уже выполняется…' };
  let url;
  try { url = hubURL(value); }
  catch { return { error: 'Укажите полный адрес Хаба без пути, например https://music.example.ru или http://localhost:8080' }; }
  connecting = true;
  try {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.destroy();
    const win = createPlayer(url);
    const timeout = setTimeout(() => { if (!win.isDestroyed()) win.webContents.stop(); }, 30_000);
    try { await win.loadURL(`${url}/`); }
    finally { clearTimeout(timeout); }
    if (win.isDestroyed()) throw new Error('Окно закрыто');
    saveConfig(url);
    lastError = '';
    focus(win);
    updates?.configure(url);
    if (setupWindow && !setupWindow.isDestroyed()) setupWindow.close();
    return { ok: true };
  } catch (error) {
    console.error('Не удалось подключиться к Хабу:', error.message);
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.destroy();
    return { error: 'Не удалось открыть Хаб. Проверьте адрес, подключение к сети и доступность сервера. Для HTTPS нужен действительный сертификат.' };
  } finally { connecting = false; }
}

function trusted(event, win, allowed) {
  return win && !win.isDestroyed() && event.sender === win.webContents && event.senderFrame === win.webContents.mainFrame && allowed(event.senderFrame.url);
}

async function showPlayerDiagnostics() {
  const win = mainWindow;
  if (!win || win.isDestroyed()) return;
  let build = 'не определена';
  if (sameOrigin(win.webContents.getURL(), origin)) {
    try { build = await win.webContents.executeJavaScript("document.querySelector('meta[name=\"hm-build\"]')?.content || 'не определена'"); }
    catch { /* a navigation may be in progress */ }
  }
  if (win.isDestroyed()) return;
  const native = taskbar?.status();
  const detail = [
    `Клиент: ${app.getVersion()}`,
    `Веб-сборка: ${String(build).slice(0, 100)}`,
    `Панель Windows: ${native?.ready ? 'создана' : 'не создана'}`,
    `Связь с веб-плеером: ${playerConnected ? 'установлена' : 'нет'}`,
    native?.error || '',
    `Обновления клиента: ${updates?.state.phase || 'не настроены'}`,
    playerConnected ? 'Панель получает состояние плеера. Включите трек, чтобы активировать кнопки.'
      : 'Хаб ещё не передал состояние плеера. Обновите Хаб из каталога с новыми web/src/lib/desktopPlayer.ts и web/src/lib/listen.ts, затем нажмите Ctrl+R в приложении.',
  ].filter(Boolean).join('\n');
  await dialog.showMessageBox(win, { type: 'info', title: 'Диагностика плеера · HomeMusic', message: 'Управление на панели задач', detail, buttons: ['Закрыть'] });
}

async function checkUpdates() {
  if (!updates || !mainWindow || mainWindow.isDestroyed()) return;
  if (updates.install()) return;
  const win = mainWindow;
  const status = await updates.check();
  if (win.isDestroyed()) return;
  const message = status.phase === 'ready' ? `HomeMusic ${status.version} загружен`
    : status.phase === 'error' ? 'Не удалось обновить HomeMusic' : 'Установлена последняя версия HomeMusic';
  const detail = status.phase === 'ready' ? 'Обновление установится при закрытии приложения. Можно перезапустить сейчас.'
    : status.error || `Версия клиента: ${app.getVersion()}`;
  const answer = await dialog.showMessageBox(win, { type: status.phase === 'error' ? 'error' : 'info', title: 'Обновления HomeMusic',
    message, detail, buttons: status.phase === 'ready' ? ['Перезапустить', 'Позже'] : ['Закрыть'], defaultId: 0, cancelId: status.phase === 'ready' ? 1 : 0 });
  if (status.phase === 'ready' && answer.response === 0) updates.install();
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => focus(setupWindow || mainWindow));
  app.on('window-all-closed', () => { if (!connecting) app.quit(); });
  app.whenReady().then(async () => {
    nativeTheme.themeSource = 'dark';
    icons = Object.fromEntries(['previous', 'play', 'pause', 'next'].map((kind) => [kind, transportIcon(kind)]));
    ipcMain.on(CHANNELS.state, (event, value) => {
      if (!trusted(event, mainWindow, (url) => sameOrigin(url, origin))) return;
      const parsed = playerState(value);
      if (parsed) { playerConnected = true; state = parsed; updateButtons(); }
    });
    ipcMain.handle(CHANNELS.getConfig, (event) => {
      if (!trusted(event, setupWindow, (url) => url === setupURL)) throw new Error('Недоступно');
      const config = { ...readConfig(), error: lastError, autoConnect };
      autoConnect = false;
      return config;
    });
    ipcMain.handle(CHANNELS.connect, (event, url) => {
      if (!trusted(event, setupWindow, (value) => value === setupURL)) throw new Error('Недоступно');
      return connect(url);
    });
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: 'HomeMusic', submenu: [
        { label: 'Адрес Хаба…', click: () => showSetup() },
        { label: 'Перезагрузить', accelerator: 'CmdOrCtrl+R', click: () => mainWindow?.webContents.reload() },
        { label: 'Диагностика плеера…', click: () => void showPlayerDiagnostics() },
        { id: 'desktop-update', label: 'Проверить обновления…', enabled: false, click: () => void checkUpdates() },
        { type: 'separator' }, { label: 'Выйти', role: 'quit' },
      ] },
      { label: 'Правка', submenu: [{ role: 'undo', label: 'Отменить' }, { role: 'redo', label: 'Повторить' },
        { type: 'separator' }, { role: 'cut', label: 'Вырезать' }, { role: 'copy', label: 'Копировать' },
        { role: 'paste', label: 'Вставить' }, { role: 'selectAll', label: 'Выделить всё' }] },
      { label: 'Вид', submenu: [{ role: 'resetZoom', label: 'Исходный масштаб' }, { role: 'zoomIn', label: 'Увеличить' },
        { role: 'zoomOut', label: 'Уменьшить' }, { role: 'togglefullscreen', label: 'Полный экран' }] },
    ]));
    updates = new DesktopUpdates({
      enabled: app.isPackaged && process.platform === 'win32',
      createUpdater: (url) => {
        const { NsisUpdater } = require('electron-updater');
        return new NsisUpdater({ provider: 'generic', url, useMultipleRangeRequest: false });
      },
      onChange: (status) => {
        const item = Menu.getApplicationMenu()?.getMenuItemById('desktop-update');
        if (item) Object.assign(item, { ...updateMenu(status), enabled: app.isPackaged && process.platform === 'win32' && updateMenu(status).enabled });
      },
      onReady: (version) => {
        if (Notification.isSupported()) new Notification({ title: `HomeMusic ${version} готов к установке`,
          body: 'Обновление установится при закрытии приложения. Перезапустить сейчас можно в меню HomeMusic.' }).show();
      },
    });
    // A local window gives immediate loading feedback, including when the saved Hub is offline.
    showSetup('', !!readConfig().url);
  }).catch((error) => { dialog.showErrorBox('HomeMusic', `Не удалось запустить приложение: ${error.message}`); app.quit(); });
}
