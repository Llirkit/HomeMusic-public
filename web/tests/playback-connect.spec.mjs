import { test, expect } from '@playwright/test';

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
    if (path === '/api/auth/me') return json({ id: 1, username: 'alice', is_admin: false });
    if (path === '/api/events') return route.fulfill({ contentType: 'text/event-stream', body: '' });
    if (path === '/api/playback/heartbeat') {
      const body = req.postDataJSON();
      shared.devices[body.device_id] = { id: body.device_id, name: body.device_id === 'computer-1' ? 'Компьютер' : 'Телефон Android' };
      if (body.claim) {
        if (body.revision !== shared.revision) return json({ detail: 'Воспроизведение изменилось' }, 409);
        if (shared.device_id !== body.device_id) shared.revision++;
        shared.device_id = body.device_id;
      }
      if (body.snapshot && shared.device_id === body.device_id && (body.claim || body.revision === shared.revision)) shared.snapshot = body.snapshot;
      return json({ ...shared, devices: Object.values(shared.devices) });
    }
    if (path === '/api/playback/transfer') {
      const body = req.postDataJSON();
      if (shared.fail || body.revision !== shared.revision) return json({ detail: 'Устройство недоступно. Откройте HomeMusic и повторите.' }, 409);
      shared.device_id = body.device_id; shared.revision++; shared.snapshot.autoplay = body.autoplay;
      return json({ ...shared, devices: Object.values(shared.devices) });
    }
    if (path === '/api/listen') return json({ kind: 'library', duration_s: 180 });
    if (path === '/api/starred') return json({ song_ids: [], album_ids: [], refs: [], subjects: [] });
    if (path === '/api/publications') { shared.publication = req.postDataJSON(); return json({ id: 'station', title: 'Радио', kind: 'radio', url: 'https://music.test/#/radio/station' }); }
    return json({});
  });
  await page.goto('/#/player');
  await expect.poll(() => Object.keys(shared.devices).includes(name)).toBe(true);
  await page.evaluate(async () => { window.player = await import('/src/lib/listen.ts'); });
  return page;
}

function state() { return { revision: 0, device_id: null, snapshot: null, devices: {} }; }
async function startTenth(page, context = 'playlist:p1') {
  await page.evaluate(context => {
    const queue = Array.from({ length: 12 }, (_, n) => ({ ref: `nd:s${n + 1}`, title: `Песня ${n + 1}`, artist: 'Кино', duration_s: 180 }));
    window.player.listen(queue[9], queue, context);
    window.player.seek(73);
  }, context);
}

test('pause on PC, open another device and continue the tenth track at the saved position', async ({ browser }, testInfo) => {
  const shared = state();
  const pcContext = await browser.newContext(), phoneContext = await browser.newContext({ viewport: { width: 393, height: 851 }, isMobile: true, hasTouch: true });
  try {
    const pc = await playerPage(pcContext, shared, 'computer-1');
    await startTenth(pc);
    await pc.evaluate(() => window.player.pause());
    await expect.poll(() => shared.snapshot?.position).toBe(73);
    expect(shared.snapshot.autoplay).toBe(false);
    const phone = await playerPage(phoneContext, shared, 'telephone-1');
    await expect(phone.getByText('Песня 10', { exact: true }).first()).toBeVisible();
    expect(await phone.evaluate(() => window.player.getListenState().phase)).toBe('paused');
    await expect(phone.getByRole('button', { name: 'Продолжить здесь', exact: true })).toHaveCount(0);
    await phone.getByRole('button', { name: 'Слушать', exact: true }).click();
    await expect.poll(() => phone.evaluate(() => window.player.getListenState().phase)).toBe('playing');
    expect(await phone.evaluate(() => window.player.getListenState().position)).toBe(73);
    expect(await phone.evaluate(() => window.player.getListenState().queue.length)).toBe(12);
    await expect.poll(() => pc.evaluate(() => window.player.getListenState().phase)).toBe('paused');
    expect(shared.device_id).toBe('telephone-1');
    await phone.screenshot({ path: testInfo.outputPath('continued-on-phone.png'), fullPage: true });
    expect(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  } finally { await pcContext.close(); await phoneContext.close(); }
});

test('Android and PC mirror both directions without restarting sound or accepting obsolete native callbacks', async ({ browser }) => {
  const shared = state();
  const context = await browser.newContext();
  try {
    const phone = await playerPage(context, shared, 'telephone-1', true);
    const pc = await playerPage(context, shared, 'computer-1');
    await startTenth(phone);
    const loads = () => phone.evaluate(() => window.nativeCommands.filter(c => c.op === 'load'));
    await expect.poll(loads).toHaveLength(1);
    const [original] = await loads();
    const nativeState = async (id, patch = {}) => phone.evaluate(({ id, patch }) => {
      window.hmAndroidPlayback({ id, index: 9, position: 73, duration: 180, playing: true, playWhenReady: true, state: 3, cycle: 0, error: false, ...patch });
    }, { id, patch });
    await nativeState(original.id);
    await expect.poll(() => shared.device_id).toBe('telephone-1');
    await expect.poll(() => pc.evaluate(() => window.player.getListenState().track?.ref)).toBe('nd:s10');
    await expect(pc.getByText('Играет: Телефон Android', { exact: true })).toBeVisible();
    expect(await pc.evaluate(() => window.player.listenAudio()?.getAttribute('src') ?? null)).toBeFalsy();

    // A normal song click on the PC selects the PC, without a second continuation button.
    await pc.evaluate(() => window.player.listen({ ref: 'nd:pc', title: 'Песня с компьютера', artist: 'Кино', duration_s: 180 }));
    await expect.poll(() => shared.device_id).toBe('computer-1');
    await expect.poll(() => phone.evaluate(() => window.player.getListenState().track?.ref)).toBe('nd:pc');
    await expect(phone.getByText('Играет: Компьютер', { exact: true })).toBeVisible();
    await expect.poll(() => phone.evaluate(id => window.nativeCommands.some(c => c.op === 'stop' && c.id === id), original.id)).toBe(true);
    const commandCount = await phone.evaluate(() => window.nativeCommands.length);
    await nativeState(original.id, { index: 0, position: 2 });
    await nativeState(original.id, { state: -1 });
    expect(await phone.evaluate(() => window.player.getListenState().track?.ref)).toBe('nd:pc');
    expect(await phone.evaluate(() => window.nativeCommands.length)).toBe(commandCount);
    await expect.poll(loads).toHaveLength(1);

    await pc.evaluate(() => window.player.seek(83));
    await expect.poll(() => phone.evaluate(() => window.player.getListenState().position)).toBe(83);
    await expect(phone.getByRole('button', { name: 'Продолжить здесь', exact: true })).toHaveCount(0);
    await phone.getByRole('button', { name: 'Слушать', exact: true }).click();
    await expect.poll(loads).toHaveLength(2);
    const resumed = (await loads())[1];
    expect(resumed.queue[0].ref).toBe('nd:pc');
    expect(resumed.position).toBe(83);
    await nativeState(resumed.id, { index: 0, position: 84 });
    await expect.poll(() => shared.device_id).toBe('telephone-1');
    await expect.poll(() => pc.evaluate(() => window.player.getListenState().position)).toBe(84);
    await expect(pc.getByText('Играет: Телефон Android', { exact: true })).toBeVisible();
    expect(await pc.evaluate(() => window.player.listenAudio()?.getAttribute('src') ?? null)).toBeFalsy();

    await phone.getByRole('button', { name: 'Аудиовыход', exact: true }).click();
    await phone.getByRole('dialog', { name: 'Аудиовыход', exact: true }).getByRole('button', { name: 'Компьютер', exact: true }).click();
    await expect.poll(() => shared.device_id).toBe('computer-1');
    await expect.poll(() => pc.evaluate(() => window.player.getListenState().phase)).toBe('playing');
    await expect.poll(() => phone.evaluate(id => window.nativeCommands.some(c => c.op === 'stop' && c.id === id), resumed.id)).toBe(true);
  } finally { await context.close(); }
});

test('select phone in audio output, stop sender, handle unavailable target and keyboard exit', async ({ browser }, testInfo) => {
  const shared = state();
  const context = await browser.newContext();
  try {
    const pc = await playerPage(context, shared, 'computer-1');
    const phone = await playerPage(context, shared, 'telephone-1');
    await startTenth(pc);
    await expect.poll(() => shared.snapshot?.index).toBe(9);
    await pc.getByRole('button', { name: 'Аудиовыход', exact: true }).first().click();
    const sheet = pc.getByRole('dialog', { name: 'Аудиовыход', exact: true });
    await expect(sheet.getByRole('button', { name: 'Телефон Android', exact: true })).toBeVisible();
    shared.fail = true;
    await sheet.getByRole('button', { name: 'Телефон Android', exact: true }).click();
    await expect(sheet.getByRole('alert')).toHaveText(/Устройство недоступно/);
    shared.fail = false;
    await sheet.getByRole('button', { name: 'Телефон Android', exact: true }).click();
    await expect.poll(() => shared.device_id).toBe('telephone-1');
    await expect.poll(() => phone.evaluate(() => window.player.getListenState().phase)).toBe('playing');
    expect(await phone.evaluate(() => window.player.getListenState().position)).toBe(73);
    expect(await pc.evaluate(() => window.player.getListenState().phase)).toBe('paused');
    await pc.screenshot({ path: testInfo.outputPath('device-picker.png'), fullPage: true });
    await pc.keyboard.press('Escape');
    await expect(sheet).toBeHidden();
    expect(await pc.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  } finally { await context.close(); }
});

for (const source of ['playlist', 'mix', 'wave']) {
  test(`radio from playing ${source} sends the current track and position`, async ({ page }) => {
    const shared = state();
    // Reuse the route/media setup in the runner's viewport.
    const player = await playerPage(page.context(), shared, 'computer-1');
    await startTenth(player, `${source}:123`);
    await player.evaluate(async source => {
      const React = (await import('/node_modules/.vite/deps/react.js')).default;
      const { createRoot } = (await import('/node_modules/.vite/deps/react-dom_client.js')).default;
      const { PublicationActions } = await import('/src/components/PublicationActions.tsx');
      const box = document.createElement('div'); document.body.append(box);
      createRoot(box).render(React.createElement(PublicationActions, { sourceKind: source, sourceId: '123', radio: true }));
    }, source);
    await player.getByRole('button', { name: 'Создать онлайн-радио', exact: true }).last().click();
    await expect.poll(() => shared.publication?.playback?.index).toBe(9);
    expect(shared.publication.playback.queue[9].ref).toBe('nd:s10');
    expect(shared.publication.playback.position).toBe(73);
    await player.close();
  });
}
