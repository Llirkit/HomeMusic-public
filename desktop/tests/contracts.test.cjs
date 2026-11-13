const { test } = require('node:test');
const assert = require('node:assert/strict');
const { hubURL, sameOrigin, playerState, EMPTY_STATE, thumbbar } = require('../src/contracts.cjs');

test('Hub configuration allows HTTP(S) roots and rejects executable URLs, credentials and paths', () => {
  assert.equal(hubURL('http://localhost:8080/'), 'http://localhost:8080');
  assert.equal(hubURL('https://music.example.ru'), 'https://music.example.ru');
  for (const url of ['file:///tmp/music', 'javascript:alert(1)', 'https://user:secret@example.ru', 'https://example.ru/other', 'https://example.ru/?token=secret']) {
    assert.throws(() => hubURL(url));
  }
  assert.equal(sameOrigin('https://music.example.ru/#/player', 'https://music.example.ru'), true);
  assert.equal(sameOrigin('https://music.example.ru.attacker.test/', 'https://music.example.ru'), false);
  assert.equal(sameOrigin('http://music.example.ru/', 'https://music.example.ru'), false);
});

test('IPC state is validated and inactive players cannot leave enabled controls', () => {
  assert.equal(playerState({ active: true }), null);
  assert.equal(playerState({ ...EMPTY_STATE, active: 'yes' }), null);
  assert.deepEqual(playerState({ ...EMPTY_STATE, canNext: true, title: 'old track' }), EMPTY_STATE);
  assert.equal(playerState({ ...EMPTY_STATE, active: true, title: 'x'.repeat(1000) }).title.length, 300);
});

test('thumbnail actions keep their order and follow playback and queue availability', () => {
  const icons = { previous: 'prev', play: 'play', pause: 'pause', next: 'next' };
  const commands = [];
  let buttons = thumbbar(EMPTY_STATE, icons, (command) => commands.push(command));
  assert.equal(buttons.length, 3);
  assert.ok(buttons.every((button) => button.flags.includes('disabled')));
  buttons = thumbbar({ ...EMPTY_STATE, active: true, playing: true, canPrevious: true }, icons, (command) => commands.push(command));
  assert.equal(buttons[1].icon, 'pause');
  assert.equal(buttons[1].tooltip, 'Пауза');
  assert.deepEqual(buttons[0].flags, []);
  assert.deepEqual(buttons[2].flags, ['disabled']);
  buttons[0].click(); buttons[1].click(); buttons[2].click();
  assert.deepEqual(commands, ['previous', 'toggle', 'next']);
});
