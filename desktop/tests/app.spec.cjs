const { test, expect, _electron: electron } = require('@playwright/test');
const { createServer } = require('node:http');
const { mkdtempSync, rmSync, readFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execute = promisify(execFile);

test('installed shell connects, synchronizes native buttons, sends commands while minimized and resets on reload', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'hm-desktop-'));
  const server = createServer((_request, response) => {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end(`<html lang="ru"><body><h1>Хаб</h1><script>
      window.commands = [];
      window.HomeMusicDesktop.onCommand(command => window.commands.push(command));
    </script></body></html>`);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const launch = () => electron.launch({
    executablePath: process.env.HOMEMUSIC_TEST_EXECUTABLE || undefined,
    args: [...(process.env.HOMEMUSIC_TEST_EXECUTABLE ? [] : [path.join(__dirname, '..')]), `--user-data-dir=${directory}`],
  });
  let app;
  try {
    app = await launch();
    const setup = await app.firstWindow();
    await expect(setup.getByRole('heading')).toHaveText('Ваша музыка. Ваш HomeMusic.');
    await setup.getByLabel('Адрес Хаба', { exact: true }).fill('https://example.ru/wrong-path');
    await setup.getByRole('button', { name: 'Подключиться' }).click();
    await expect(setup.getByRole('alert')).toContainText('без пути');

    const unavailable = createServer();
    await new Promise((resolve) => unavailable.listen(0, '127.0.0.1', resolve));
    const unavailableURL = `http://127.0.0.1:${unavailable.address().port}`;
    await new Promise((resolve) => unavailable.close(resolve));
    await setup.getByLabel('Адрес Хаба', { exact: true }).fill(unavailableURL);
    await setup.getByRole('button', { name: 'Подключиться' }).click();
    await expect(setup.getByRole('alert')).toContainText('Не удалось открыть Хаб');
    await expect(setup.getByRole('button', { name: 'Подключиться' })).toBeEnabled();

    // Capture the actual API calls and their click callbacks, leaving native toolbar creation in place.
    await app.evaluate(({ BrowserWindow }) => {
      globalThis.toolbar = [];
      globalThis.toolbarVisibility = [];
      const original = BrowserWindow.prototype.setThumbarButtons;
      BrowserWindow.prototype.setThumbarButtons = function (buttons) {
        globalThis.toolbar = buttons;
        globalThis.toolbarVisibility.push(this.isVisible() || this.isMinimized());
        globalThis.toolbarAccepted = process.platform === 'win32' ? original.call(this, buttons) : true;
        return globalThis.toolbarAccepted;
      };
    });
    const windowPromise = app.waitForEvent('window');
    await setup.getByLabel('Адрес Хаба', { exact: true }).fill(url);
    await setup.getByRole('button', { name: 'Подключиться' }).click();
    const player = await windowPromise;
    await expect(player.getByRole('heading')).toHaveText('Хаб');
    expect(await player.evaluate(async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach(track => track.stop());
        return false;
      } catch { return true; }
    })).toBe(true);
    expect(await player.evaluate(async () => (await navigator.mediaDevices.enumerateDevices()).every(d =>
      !d.label || d.kind === 'audiooutput'))).toBe(true);
    await expect.poll(() => setup.isClosed()).toBe(true);
    expect(JSON.parse(readFileSync(path.join(directory, 'config.json'), 'utf8')).url).toBe(url);
    expect(await player.evaluate(() => typeof window.require)).toBe('undefined');
    expect(await player.evaluate(() => typeof window.HomeMusicSetup)).toBe('undefined');
    // This fixture behaves like an old Hub: no initial player IPC. The toolbar must still exist.
    await expect.poll(() => app.evaluate(() => globalThis.toolbar.length)).toBe(process.platform === 'win32' ? 3 : 0);
    if (process.platform === 'win32') {
      expect(await app.evaluate(() => globalThis.toolbarVisibility.every(Boolean))).toBe(true);
      expect(await app.evaluate(() => globalThis.toolbar.every((button) => button.flags.includes('disabled')))).toBe(true);
      expect(await app.evaluate(() => globalThis.toolbarAccepted)).toBe(true);
    }
    await app.evaluate(async ({ Menu, dialog }) => {
      dialog.showMessageBox = async (_window, options) => { globalThis.diagnostics = options; return { response: 0 }; };
      await Menu.getApplicationMenu().items[0].submenu.items.find((item) => item.label === 'Диагностика плеера…').click();
    });
    await expect.poll(() => app.evaluate(() => globalThis.diagnostics?.detail)).toContain('Связь с веб-плеером: нет');
    await player.evaluate(() => localStorage.setItem('hm-test-session', 'retained'));
    await player.evaluate(() => window.HomeMusicDesktop.updatePlayer({ active: true, playing: true, canNext: true, canPrevious: true, title: 'Песня', artist: 'Исполнитель' }));
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getTitle())).toBe('Песня — Исполнитель · HomeMusic');
    await expect.poll(() => app.evaluate(() => globalThis.toolbar.map((button) => button.tooltip))).toEqual(['Предыдущий трек', 'Пауза', 'Следующий трек']);
    expect(await app.evaluate(() => globalThis.toolbarAccepted)).toBe(true);
    const handle = await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      window.minimize();
      return window.getNativeWindowHandle().readBigUInt64LE().toString();
    });
    for (let index = 0; index < 3; index++) {
      if (process.platform === 'win32') {
        const script = readFileSync(path.join(__dirname, 'click-thumbnail.ps1'), 'utf8');
        await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `& {\n${script}\n} -WindowHandle ${handle} -Index ${index}`]);
      } else await app.evaluate((_electron, i) => globalThis.toolbar[i].click(), index);
    }
    await expect.poll(() => player.evaluate(() => window.commands)).toEqual(['previous', 'toggle', 'next']);
    await player.evaluate(() => window.HomeMusicDesktop.updatePlayer({ active: true, playing: false, canNext: false, canPrevious: true, title: 'Песня', artist: 'Исполнитель' }));
    await expect.poll(() => app.evaluate(() => globalThis.toolbar[1].tooltip)).toBe('Воспроизвести');
    await app.evaluate(() => globalThis.toolbar[2].click());
    expect(await player.evaluate(() => window.commands)).toEqual(['previous', 'toggle', 'next']);
    await player.reload();
    await expect.poll(() => app.evaluate(() => globalThis.toolbar.every((button) => button.flags.includes('disabled')))).toBe(true);
    await player.evaluate(() => window.HomeMusicDesktop.updatePlayer({ active: true }));
    expect(await app.evaluate(() => globalThis.toolbar.every((button) => button.flags.includes('disabled')))).toBe(true);
    // An unrelated origin cannot retain the preload bridge, even through a main-process navigation.
    await app.evaluate(async ({ BrowserWindow }) => { await BrowserWindow.getAllWindows()[0].loadURL('data:text/html,<h1>Other origin</h1>'); });
    expect(await player.evaluate(() => typeof window.HomeMusicDesktop)).toBe('undefined');
    expect(await app.evaluate(() => globalThis.toolbar.every((button) => button.flags.includes('disabled')))).toBe(true);
    await app.close();
    app = await launch();
    await expect.poll(() => app.windows().some((window) => window.url().startsWith(url))).toBe(true);
    const restored = app.windows().find((window) => window.url().startsWith(url));
    await expect(restored.getByRole('heading')).toHaveText('Хаб');
    expect(await restored.evaluate(() => localStorage.getItem('hm-test-session'))).toBe('retained');
  } finally {
    await app?.close();
    await new Promise((resolve) => server.close(resolve));
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
