const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { attachTaskbar } = require('../src/taskbar.cjs');

function window() {
  const win = new EventEmitter();
  win.shown = false;
  win.destroyed = false;
  win.calls = [];
  win.isVisible = () => win.shown;
  win.isMinimized = () => false;
  win.isDestroyed = () => win.destroyed;
  win.setThumbarButtons = (buttons) => { win.calls.push(buttons); return true; };
  return win;
}

test('initializes after showing the window, even if the Hub never sends player state', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const win = window();
  let buttons = ['disabled'];
  const bar = attachTaskbar(win, () => buttons);
  bar.update();
  t.mock.timers.tick(1000);
  assert.equal(win.calls.length, 0, 'must not initialize on a hidden HWND');
  win.shown = true;
  win.emit('show');
  win.emit('focus');
  t.mock.timers.tick(200);
  assert.deepEqual(win.calls, [['disabled']]);
  assert.equal(bar.status().ready, true);
  buttons = ['playing'];
  bar.update();
  assert.deepEqual(win.calls.at(-1), ['playing']);
});

test('retries a native failure with the latest state and cancels pending work on close', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const win = window();
  win.shown = true;
  let accepted = false;
  let buttons = ['disabled'];
  win.setThumbarButtons = (value) => { win.calls.push(value); return accepted; };
  const bar = attachTaskbar(win, () => buttons, () => {});
  t.mock.timers.tick(200);
  assert.equal(bar.status().ready, false);
  accepted = true;
  buttons = ['playing'];
  t.mock.timers.tick(500);
  assert.deepEqual(win.calls.at(-1), ['playing']);
  assert.equal(bar.status().ready, true);
  win.emit('focus');
  win.destroyed = true;
  win.emit('closed');
  t.mock.timers.tick(1000);
  assert.equal(win.calls.length, 2);
});
