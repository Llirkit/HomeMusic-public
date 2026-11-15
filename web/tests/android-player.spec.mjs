import { test, expect } from '@playwright/test';

test('Android delegates its queue to Media3 and follows native lock-screen controls without web audio', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    window.nativeCommands = [];
    window.SpotikPlayback = { command: json => window.nativeCommands.push(JSON.parse(json)) };
    window.Audio = class { constructor() { throw new Error('Android must not create browser audio'); } };
  });
  await page.route('**/healthz', route => route.fulfill({ json: { ok: true, capabilities: [] } }));
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (!path.startsWith('/api/')) return route.fallback();
    if (path === '/api/auth/me') return route.fulfill({ json: { id: 1, username: 'test', is_admin: false } });
    if (path === '/api/listen') return route.fulfill({ json: { kind: 'full', duration_s: 180 } });
    if (path === '/api/events') return route.fulfill({ contentType: 'text/event-stream', body: '' });
    if (path === '/api/starred') return route.fulfill({ json: { song_ids: [], album_ids: [], refs: [], subjects: [] } });
    return route.fulfill({ json: {} });
  });
  await page.goto('/#/player');
  await page.evaluate(async () => {
    window.player = await import('/src/lib/listen.ts');
    window.tracks = [1, 2, 3].map(id => ({ ref: `nd:${id}`, title: `Песня ${id}`, artist: 'Исполнитель', duration_s: 180 }));
    window.player.listen(window.tracks[0], window.tracks, 'album');
  });
  const loads = () => page.evaluate(() => window.nativeCommands.filter(c => c.op === 'load'));
  await expect.poll(loads).toHaveLength(1);
  const [load] = await loads();
  expect(load.queue).toHaveLength(3);
  expect(load.index).toBe(0);
  await expect.poll(() => page.evaluate(() => window.nativeCommands.some(c => c.op === 'play'))).toBe(true);
  const snapshot = async patch => page.evaluate(({ id, patch }) => {
    window.hmAndroidPlayback({ id, index: 0, position: 12, duration: 180, playing: true, playWhenReady: true, state: 3, cycle: 0, error: false, ...patch });
  }, { id: load.id, patch });
  await snapshot({});
  await expect(page.getByRole('button', { name: 'Пауза', exact: true })).toBeVisible();
  // Native timeline advances while the UI is backgrounded: it must adopt, not reload the stream.
  await snapshot({ index: 1, position: 2 });
  await expect.poll(() => page.evaluate(() => window.player.getListenState().index)).toBe(1);
  expect(await loads()).toHaveLength(1);
  await snapshot({ index: 1, position: 19, playing: false, playWhenReady: false });
  await expect(page.getByRole('button', { name: 'Слушать', exact: true }).first()).toBeVisible();
  await snapshot({ index: 1, position: 19 });
  await expect(page.getByRole('button', { name: 'Пауза', exact: true })).toBeVisible();
  await page.evaluate(() => window.player.seek(44));
  expect(await page.evaluate(() => window.nativeCommands.some(c => c.op === 'seek' && c.position === 44))).toBe(true);
  await page.evaluate(() => window.player.removeFromQueue(2));
  await expect.poll(() => page.evaluate(() => window.nativeCommands.filter(c => c.op === 'queue').at(-1)?.queue.length)).toBe(2);
  await snapshot({ id: 'obsolete', index: 0 });
  expect(await page.evaluate(() => window.player.getListenState().index)).toBe(1);
  await snapshot({ state: -1 }); // Offline playback replaces online playback in the same native player.
  await expect(page.getByText('Сейчас ничего не играет')).toBeVisible();
  await snapshot({ index: 0 });
  await expect(page.getByText('Сейчас ничего не играет')).toBeVisible();
  expect(errors).toEqual([]);
});
