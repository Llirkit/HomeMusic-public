const { hubURL } = require('./contracts.cjs');
const FEED_PATH = '/desktop/updates/windows/x64/';

/** One updater per selected Hub. A previous server must never install its pending download. */
class DesktopUpdates {
  constructor({ createUpdater, enabled, onChange = () => {}, onReady = () => {} }) {
    this.createUpdater = createUpdater;
    this.enabled = enabled;
    this.onChange = onChange;
    this.onReady = onReady;
    this.state = { phase: 'idle', version: '', percent: 0, error: '' };
    this.origin = null;
    this.updater = null;
    this.pending = null;
    this.token = null;
  }

  set(patch) {
    this.state = { ...this.state, ...patch };
    this.onChange(this.state);
  }

  configure(value) {
    const origin = hubURL(value);
    if (origin === this.origin) return;
    this.dispose();
    this.origin = origin;
    this.set({ phase: 'idle', version: '', percent: 0, error: '' });
    if (!this.enabled) return;
    const updater = this.createUpdater(origin + FEED_PATH);
    this.updater = updater;
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = false;
    updater.allowDowngrade = false;
    updater.allowPrerelease = false;
    const listen = (name, callback) => updater.on(name, (...args) => {
      if (this.updater === updater) callback(...args);
    });
    listen('checking-for-update', () => this.set({ phase: 'checking', error: '' }));
    listen('update-not-available', () => this.set({ phase: 'current' }));
    listen('update-available', (info) => this.set({ phase: 'available', version: info.version, percent: 0 }));
    listen('download-progress', (progress) => this.set({ phase: 'downloading', percent: Math.max(0, Math.min(100, Math.round(progress.percent))) }));
    listen('update-downloaded', (info) => {
      updater.autoInstallOnAppQuit = true;
      this.set({ phase: 'ready', version: info.version, percent: 100 });
      this.onReady(info.version);
    });
    listen('error', () => this.set({ phase: 'error', error: 'Не удалось получить обновление. Проверьте подключение к Хабу и повторите проверку.' }));
    this.initial = setTimeout(() => { void this.check(); }, 10_000);
    this.initial.unref?.();
    this.interval = setInterval(() => { void this.check(); }, 6 * 60 * 60 * 1000);
    this.interval.unref?.();
  }

  check() {
    if (this.pending) return this.pending;
    if (!this.updater || this.state.phase === 'ready') return Promise.resolve(this.state);
    const updater = this.updater;
    this.set({ phase: 'checking', error: '' });
    this.pending = (async () => {
      try {
        const result = await updater.checkForUpdates();
        if (this.updater !== updater) { result?.cancellationToken?.cancel(); return this.state; }
        this.token = result?.cancellationToken;
        if (result?.isUpdateAvailable) {
          this.set({ phase: 'downloading' });
          await updater.downloadUpdate(this.token);
        }
      } catch {
        if (this.updater === updater) this.set({ phase: 'error', error: 'Не удалось скачать или проверить обновление. Повторите проверку через меню HomeMusic.' });
      } finally {
        if (this.updater === updater) { this.pending = null; this.token = null; }
      }
      return this.state;
    })();
    return this.pending;
  }

  install() {
    if (this.state.phase !== 'ready' || !this.updater) return false;
    this.updater.quitAndInstall(true, true);
    return true;
  }

  dispose() {
    clearTimeout(this.initial);
    clearInterval(this.interval);
    if (this.updater) this.updater.autoInstallOnAppQuit = false;
    this.updater = null;
    this.token?.cancel();
    this.token = null;
    this.pending = null;
  }
}

function updateMenu(state) {
  if (state.phase === 'ready') return { label: `Перезапустить и обновить до ${state.version}`, enabled: true };
  if (state.phase === 'downloading') return { label: `Загрузка обновления: ${state.percent}%`, enabled: false };
  if (['checking', 'available'].includes(state.phase)) return { label: 'Проверка обновлений…', enabled: false };
  return { label: 'Проверить обновления…', enabled: true };
}

module.exports = { DesktopUpdates, updateMenu, FEED_PATH };
