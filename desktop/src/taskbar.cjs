/** Keep early page/IPC events away from an HWND that has no taskbar button yet. */
function attachTaskbar(win, buttons, report = console.error) {
  let timer = null;
  let ready = false;
  let attempts = 0;
  let lastError = '';
  const visible = () => !win.isDestroyed() && (win.isVisible() || win.isMinimized());
  const schedule = (delay = 200) => {
    if (timer || !visible()) return;
    timer = setTimeout(() => { timer = null; apply(); }, delay);
  };
  const apply = () => {
    if (!visible()) return;
    attempts++;
    try {
      ready = win.setThumbarButtons(buttons());
      lastError = ready ? '' : 'Windows не приняла панель кнопок';
    } catch (error) { ready = false; lastError = error.message; }
    if (!ready) {
      report(`Не удалось обновить кнопки превью HomeMusic: ${lastError}`);
      if (attempts < 5) schedule(500);
    }
  };
  const shown = () => { attempts = 0; schedule(); };
  win.on('show', shown);
  win.on('restore', shown);
  win.on('focus', shown);
  win.once('closed', () => { clearTimeout(timer); timer = null; });
  schedule();
  return {
    update() { if (ready) apply(); else schedule(); },
    status: () => ({ ready, attempts, error: lastError }),
  };
}

module.exports = { attachTaskbar };
