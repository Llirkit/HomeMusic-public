const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { DesktopUpdates, updateMenu } = require('../src/updates.cjs');

function fakeUpdater() {
  const updater = new EventEmitter();
  updater.checks = 0;
  updater.downloads = 0;
  updater.cancelled = false;
  updater.checkForUpdates = async () => {
    updater.checks++;
    updater.emit('checking-for-update');
    updater.emit('update-available', { version: '1.0.3' });
    return { isUpdateAvailable: true, cancellationToken: { cancel: () => { updater.cancelled = true; } } };
  };
  updater.downloadUpdate = async () => {
    updater.downloads++;
    updater.emit('download-progress', { percent: 42.3 });
    updater.emit('update-downloaded', { version: '1.0.3' });
  };
  updater.quitAndInstall = (...args) => { updater.installed = args; };
  return updater;
}

test('downloads in the background, deduplicates checks and installs only a verified ready update', async () => {
  const updater = fakeUpdater();
  const states = [];
  const controller = new DesktopUpdates({ enabled: true, createUpdater: () => updater, onChange: (s) => states.push(s) });
  controller.configure('https://music.example.ru');
  assert.equal(controller.install(), false);
  const first = controller.check();
  assert.equal(controller.check(), first);
  await first;
  assert.equal(updater.checks, 1);
  assert.equal(updater.downloads, 1);
  assert.equal(updater.autoInstallOnAppQuit, true);
  assert.ok(states.some((s) => s.phase === 'downloading' && s.percent === 42));
  assert.equal(controller.state.phase, 'ready');
  assert.match(updateMenu(controller.state).label, /1\.0\.3/);
  assert.equal(controller.install(), true);
  assert.deepEqual(updater.installed, [true, true]);
  controller.dispose();
  assert.equal(updater.autoInstallOnAppQuit, false);
});

test('a changed server cancels the old download and never installs its late result', async () => {
  const old = fakeUpdater();
  let finish;
  old.downloadUpdate = () => new Promise((resolve) => { finish = resolve; });
  const next = fakeUpdater();
  const urls = [];
  const controller = new DesktopUpdates({ enabled: true, createUpdater: (url) => { urls.push(url); return urls.length === 1 ? old : next; } });
  controller.configure('https://first.example.ru');
  const checking = controller.check();
  await new Promise((resolve) => setImmediate(resolve));
  controller.configure('http://localhost:8080');
  assert.equal(old.cancelled, true);
  old.emit('update-downloaded', { version: '99.0.0' });
  finish();
  await checking;
  assert.equal(old.autoInstallOnAppQuit, false);
  assert.equal(controller.state.phase, 'idle');
  assert.deepEqual(urls, ['https://first.example.ru/desktop/updates/windows/x64/', 'http://localhost:8080/desktop/updates/windows/x64/']);
  controller.dispose();
});

test('offline and failed integrity checks leave the application usable and allow retry', async () => {
  const updater = fakeUpdater();
  updater.downloadUpdate = async () => { throw new Error('sha512 checksum mismatch'); };
  const controller = new DesktopUpdates({ enabled: true, createUpdater: () => updater });
  controller.configure('https://music.example.ru');
  await controller.check();
  assert.equal(controller.state.phase, 'error');
  assert.equal(controller.install(), false);
  assert.equal(updater.autoInstallOnAppQuit, false);
  updater.downloadUpdate = async () => updater.emit('update-downloaded', { version: '1.0.3' });
  await controller.check();
  assert.equal(controller.state.phase, 'ready');
  controller.dispose();
});
