import { test, expect } from '@playwright/test';

const tracks = Array.from({ length: 12 }, (_, n) => ({ ref: `nd:s${n + 1}`, title: `Песня ${n + 1}`, artist: 'Кино', duration_s: 180 }));
const state = () => ({ revision: 0, applied_revision: 0, device_id: null, snapshot: null, devices: {}, commands: new Map() });

async function playerPage(context, shared, name, native = false) {
  const page = await context.newPage();
  await page.addInitScript(({ name, native }) => {
    sessionStorage.setItem('hm-device-id', name);
    if (native) {
      window.nativeCommands = [];
      window.SpotikPlayback = { command: text => window.nativeCommands.push(JSON.parse(text)) };
    }
    window.Audio = class extends EventTarget {
      currentTime = 0; duration = 180; readyState = 4; paused = true; ended = false; src = '';
      play() { this.paused = false; this.dispatchEvent(new Event('loadedmetadata')); this.dispatchEvent(new Event('playing')); return Promise.resolve(); }
      pause() { this.paused = true; this.dispatchEvent(new Event('pause')); }
      load() { this.dispatchEvent(new Event('loadedmetadata')); }
      getAttribute(key) { return key === 'src' ? this.src : null; }
      removeAttribute() { this.src = ''; }
    };
  }, { name, native });
  await page.route('**/healthz', route => route.fulfill({ json: { ok: true, capabilities: ['typed_favorites_v1'] } }));
  await page.route('**/api/**', async route => {
    const req = route.request(), path = new URL(req.url()).pathname;
    if (!path.startsWith('/api/')) return route.fallback();
    const json = (value, status = 200) => route.fulfill({ status, json: value });
    const output = () => ({ revision: shared.revision, applied_revision: shared.applied_revision, device_id: shared.device_id,
      snapshot: shared.snapshot, devices: Object.values(shared.devices), action: shared.action,
      pending: shared.applied_revision < shared.revision && !!shared.snapshot });
    if (path === '/api/auth/me') return json({ id: 1, username: 'alice', is_admin: false });
    if (path === '/api/events') return route.fulfill({ contentType: 'text/event-stream', body: '' });
    if (path === '/api/playback/heartbeat') {
      const body = req.postDataJSON();
      shared.devices[body.device_id] = { id: body.device_id, name: body.device_id === 'computer-1' ? 'Компьютер' : 'Телефон Android', volume: body.volume ?? 1 };
      if (body.claim) {
        if (body.revision !== shared.revision) return json({ detail: 'Воспроизведение изменилось' }, 409);
        if (shared.device_id !== body.device_id) shared.revision++;
        shared.device_id = body.device_id;
      }
      if (body.snapshot && shared.device_id === body.device_id && (body.claim || body.revision === shared.revision)) {
        shared.snapshot = body.snapshot; shared.applied_revision = shared.revision;
      }
      return json(output());
    }
    if (path === '/api/playback/transfer') {
      const body = req.postDataJSON();
      if (shared.fail || body.revision !== shared.revision) return json({ detail: 'Устройство недоступно. Откройте HomeMusic и повторите.' }, 409);
      if (shared.device_id !== body.device_id) {
        shared.device_id = body.device_id; shared.revision++; shared.action = 'transfer';
        if (shared.snapshot) shared.snapshot.volume = shared.devices[body.device_id].volume;
      }
      return json(output());
    }
    if (path === '/api/playback/command') {
      const body = req.postDataJSON();
      if (shared.commands.has(body.command_id)) return json(output());
      if (body.revision !== shared.revision) return json({ detail: 'Очередь изменилась' }, 409);
      const s = shared.snapshot;
      if (body.action === 'start') shared.snapshot = { ...body.snapshot, volume: s?.volume ?? 1, autoplay: true, phase: 'resolving' };
      else if (body.action === 'toggle' || body.action === 'play' || body.action === 'pause') {
        s.autoplay = body.action === 'toggle' ? !s.autoplay : body.action === 'play'; s.phase = s.autoplay ? 'loading' : 'paused';
      } else if (body.action === 'next' || body.action === 'play_index') {
        s.index = body.action === 'next' ? Math.min(s.index + 1, s.queue.length - 1) : body.index; s.position = 0; s.autoplay = true; s.phase = 'resolving';
      } else if (body.action === 'previous') { s.index = s.position < 3 ? Math.max(0, s.index - 1) : s.index; s.position = 0; }
      else if (body.action === 'seek') s.position = body.position;
      else if (body.action === 'volume') s.volume = body.volume;
      else if (body.action === 'repeat') s.repeat = { off: 'all', all: 'one', one: 'off' }[s.repeat];
      else if (body.action === 'shuffle') s.shuffle = body.shuffle ?? !s.shuffle;
      else if (body.action === 'append') s.queue.push(...body.tracks);
      else if (body.action === 'add_next') s.queue.splice(s.index + 1, 0, ...body.tracks);
      else if (body.action === 'remove') { s.queue.splice(body.index, 1); if (body.index < s.index) s.index--; }
      else if (body.action === 'move') { const current = s.queue[s.index]; s.queue.splice(body.to_index, 0, s.queue.splice(body.index, 1)[0]); s.index = s.queue.indexOf(current); }
      shared.revision++; shared.action = body.action; shared.commands.set(body.command_id, body.action);
      if (shared.dropResponse === body.action) { shared.dropResponse = null; return route.abort(); }
      return json(output());
    }
    if (path === '/api/listen') return json({ kind: 'library', duration_s: 180 });
    if (path === '/api/starred') return json({ song_ids: [], album_ids: [], refs: [], subjects: [] });
    return json({});
  });
  await page.goto('/#/player');
  await expect.poll(() => Object.keys(shared.devices).includes(name)).toBe(true);
  await page.evaluate(async () => { window.player = await import('/src/lib/listen.ts'); });
  return page;
}
async function start(page, index = 9) { await page.evaluate(({ tracks, index }) => window.player.listen(tracks[index], tracks, 'playlist:p1'), { tracks, index }); }
async function output(page, name) {
  await page.getByRole('button', { name: 'Аудиовыход', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Аудиовыход', exact: true });
  await dialog.getByRole('button', { name, exact: true }).click();
  await page.keyboard.press('Escape');
}
const localPlaying = page => page.evaluate(() => !window.player.getListenState().remote && window.player.listenBusy());

test('opening another client mirrors playback; its controls keep the selected output', async ({ browser }, testInfo) => {
  const shared = state(), context = await browser.newContext({ viewport: testInfo.project.use.viewport });
  try {
    const pc = await playerPage(context, shared, 'computer-1');
    await start(pc);
    await pc.evaluate(() => window.player.seek(73));
    await expect.poll(() => shared.snapshot?.index).toBe(9);
    const phone = await playerPage(context, shared, 'telephone-1');
    await expect(phone.getByText('Играет: Компьютер', { exact: true })).toBeVisible();
    expect(await localPlaying(phone)).toBe(false);
    await expect(phone.getByRole('button', { name: 'Продолжить здесь', exact: true })).toHaveCount(0);
    await phone.getByRole('button', { name: 'Пауза', exact: true }).click();
    await expect.poll(() => pc.evaluate(() => window.player.getListenState().phase)).toBe('paused');
    expect(shared.device_id).toBe('computer-1');
    await phone.getByRole('button', { name: 'Слушать', exact: true }).click();
    await expect.poll(() => localPlaying(pc)).toBe(true);
    await phone.evaluate(() => window.player.seek(83));
    await expect.poll(() => pc.evaluate(() => window.player.getListenState().position)).toBe(83);
    await phone.evaluate(() => window.player.setVolume(0.3));
    await expect.poll(() => pc.evaluate(() => window.player.getListenState().volume)).toBe(0.3);
    await start(phone, 4);
    await expect.poll(() => pc.evaluate(() => window.player.getListenState().index)).toBe(4);
    expect(shared.device_id).toBe('computer-1');
    expect(await localPlaying(phone)).toBe(false);
    await phone.screenshot({ path: testInfo.outputPath('remote-controller.png'), fullPage: true });
    expect(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  } finally { await context.close(); }
});

test('choose an empty output, start there, and transfer paused playback without resuming', async ({ browser }, testInfo) => {
  const shared = state(), context = await browser.newContext({ viewport: testInfo.project.use.viewport });
  try {
    const pc = await playerPage(context, shared, 'computer-1');
    const phone = await playerPage(context, shared, 'telephone-1');
    await output(pc, 'Телефон Android');
    expect(shared.device_id).toBe('telephone-1');
    await start(pc);
    await expect.poll(() => localPlaying(phone)).toBe(true);
    await pc.getByRole('button', { name: 'Пауза', exact: true }).click();
    await expect.poll(() => phone.evaluate(() => window.player.getListenState().phase)).toBe('paused');
    await output(phone, 'Компьютер');
    await expect.poll(() => shared.device_id).toBe('computer-1');
    await expect.poll(() => pc.evaluate(() => window.player.getListenState().phase)).toBe('paused');
    expect(await localPlaying(pc)).toBe(false);
  } finally { await context.close(); }
});

test('Android controls and output handoff reject old callbacks and keep advancing after repeated transfers', async ({ browser }, testInfo) => {
  const shared = state(), context = await browser.newContext({ viewport: testInfo.project.use.viewport });
  try {
    const phone = await playerPage(context, shared, 'telephone-1', true);
    await start(phone);
    const loads = () => phone.evaluate(() => window.nativeCommands.filter(c => c.op === 'load'));
    await expect.poll(loads).toHaveLength(1);
    const first = (await loads())[0];
    const native = async (id, patch = {}) => phone.evaluate(({ id, patch }) => window.hmAndroidPlayback({ id, index: 9, position: 73,
      duration: 180, playing: true, playWhenReady: true, state: 3, cycle: 0, error: false, ...patch }), { id, patch });
    await native(first.id);
    const pc = await playerPage(context, shared, 'computer-1');
    await expect(pc.getByText('Играет: Телефон Android', { exact: true })).toBeVisible();
    await pc.getByRole('button', { name: 'Пауза', exact: true }).click();
    await expect.poll(() => phone.evaluate(() => window.player.getListenState().phase)).toBe('paused');
    await pc.getByRole('button', { name: 'Слушать', exact: true }).click();
    await expect.poll(() => phone.evaluate(() => window.nativeCommands.filter(c => c.op === 'play').length)).toBeGreaterThan(1);
    await native(first.id);
    await output(pc, 'Компьютер (это устройство)');
    await expect.poll(() => localPlaying(pc)).toBe(true);
    await expect.poll(() => phone.evaluate(id => window.nativeCommands.some(c => c.op === 'stop' && c.id === id), first.id)).toBe(true);
    await native(first.id, { index: 0, position: 1 });
    await native(first.id, { state: -1 });
    expect(await phone.evaluate(() => window.player.getListenState().track.ref)).toBe('nd:s10');
    expect(await phone.evaluate(() => window.player.getListenState().remote)).toBe(true);
    await pc.evaluate(() => window.player.seek(83));
    await output(pc, 'Телефон Android');
    await expect.poll(loads).toHaveLength(2);
    const second = (await loads())[1];
    expect(second.position).toBeGreaterThanOrEqual(83);
    await native(second.id, { position: 84 });
    await expect.poll(() => pc.evaluate(() => window.player.getListenState().position)).toBeGreaterThanOrEqual(84);
    expect(shared.device_id).toBe('telephone-1');
    expect(await localPlaying(pc)).toBe(false);
  } finally { await context.close(); }
});

test('queue edits and retried commands are shared without duplicating the next action', async ({ browser }, testInfo) => {
  const shared = state(), context = await browser.newContext({ viewport: testInfo.project.use.viewport });
  try {
    const pc = await playerPage(context, shared, 'computer-1'); await start(pc, 0);
    const phone = await playerPage(context, shared, 'telephone-1');
    await expect(phone.getByText('Играет: Компьютер', { exact: true })).toBeVisible();
    shared.dropResponse = 'next';
    await phone.evaluate(() => window.player.next());
    await expect.poll(() => pc.evaluate(() => window.player.getListenState().index)).toBe(1);
    expect([...shared.commands.values()].filter(v => v === 'next')).toHaveLength(1);
    await phone.evaluate(() => { window.player.addToQueue([{ ref: 'nd:extra', title: 'Ещё песня', artist: 'Кино' }]); window.player.cycleRepeat(); });
    await expect.poll(() => pc.evaluate(() => window.player.getListenState().queue.length)).toBe(13);
    await expect.poll(() => pc.evaluate(() => window.player.getListenState().repeat)).toBe('all');
    await phone.evaluate(() => window.player.moveInQueue(12, 2));
    await expect.poll(() => pc.evaluate(() => window.player.getListenState().queue[2].ref)).toBe('nd:extra');
    await phone.evaluate(() => window.player.removeFromQueue(2));
    await expect.poll(() => pc.evaluate(() => window.player.getListenState().queue.length)).toBe(12);
    expect(shared.device_id).toBe('computer-1');
  } finally { await context.close(); }
});

test('failed transfer keeps the original output; reopening a controller restores the shared pause', async ({ browser }, testInfo) => {
  const shared = state(), context = await browser.newContext({ viewport: testInfo.project.use.viewport });
  try {
    const pc = await playerPage(context, shared, 'computer-1'); await start(pc, 0);
    const phone = await playerPage(context, shared, 'telephone-1');
    await expect(phone.getByRole('button', { name: 'Пауза', exact: true })).toBeVisible();
    shared.fail = true;
    await output(phone, 'Телефон Android (это устройство)');
    await expect(phone.getByRole('alert')).toContainText('Устройство недоступно');
    expect(shared.device_id).toBe('computer-1');
    expect(await localPlaying(pc)).toBe(true);
    expect(await localPlaying(phone)).toBe(false);
    shared.fail = false;
    await phone.getByRole('button', { name: 'Пауза', exact: true }).click();
    await expect.poll(() => pc.evaluate(() => window.player.getListenState().phase)).toBe('paused');
    await phone.reload();
    await expect(phone.getByText('Пауза: Компьютер', { exact: true })).toBeVisible();
    await expect(phone.getByRole('button', { name: 'Слушать', exact: true })).toBeVisible();
    expect(shared.device_id).toBe('computer-1');
  } finally { await context.close(); }
});
