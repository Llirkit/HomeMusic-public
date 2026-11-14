import { test, expect } from '@playwright/test';

test('queue follows the current song, allows history browsing, collapse and likes without playback', async ({ page }, testInfo) => {
  await page.route('**/healthz', route => route.fulfill({ json: { ok: true, capabilities: ['typed_favorites_v1'] } }));
  await page.addInitScript(() => {
    window.Audio = class extends EventTarget {
      currentTime = 0; duration = 180; readyState = 4; paused = true; ended = false; src = '';
      play() { this.paused = false; this.dispatchEvent(new Event('playing')); return Promise.resolve(); }
      pause() { this.paused = true; this.dispatchEvent(new Event('pause')); }
      load() {}
      getAttribute(name) { return name === 'src' ? this.src : null; }
      removeAttribute() { this.src = ''; }
    };
  });
  await page.route('**/api/**', route => {
    const url = new URL(route.request().url());
    if (!url.pathname.startsWith('/api/')) return route.fallback();
    if (url.pathname === '/api/auth/me') return route.fulfill({ json: { id: 1, username: 'alice', is_admin: false } });
    if (url.pathname === '/api/listen') return route.fulfill({ json: { kind: 'full', duration_s: 180 } });
    if (url.pathname === '/api/events') return route.fulfill({ contentType: 'text/event-stream', body: '' });
    if (url.pathname === '/api/starred') return route.fulfill({ json: { song_ids: [], album_ids: [], refs: [], subjects: [] } });
    if (url.pathname === '/api/star') return route.fulfill({ json: { event_ids: ['test-like'] } });
    return route.fulfill({ json: {} });
  });
  await page.goto('/#/player');
  await expect(page.getByText('Сейчас ничего не играет')).toBeVisible();
  await page.evaluate(async () => {
    window.player = await import('/src/lib/listen.ts');
    const tracks = Array.from({ length: 30 }, (_, i) => ({ ref: `dz:${i + 1}`, title: `Песня ${i + 1}`, artist: 'Исполнитель с длинным русским именем', duration_s: 180 }));
    window.player.listen(tracks[12], tracks);
  });
  const panel = page.getByRole('region', { name: 'Список треков' });
  const queue = page.getByRole('region', { name: 'Очередь', exact: true });
  const current = panel.locator('li[aria-current="true"]');
  const aligned = () => panel.evaluate(el => Math.abs(el.scrollTop - el.querySelector('[aria-current="true"]').offsetTop));
  await expect.poll(aligned).toBeLessThan(2);
  await panel.scrollIntoViewIfNeeded();
  const outerY = await page.evaluate(() => window.scrollY);
  await panel.evaluate(el => { el.scrollTop = 0; });
  await expect(panel.getByRole('button', { name: 'Слушать «Песня 1»', exact: true })).toBeVisible();
  await page.evaluate(() => window.player.next());
  await expect(current.getByText('Песня 14', { exact: true })).toBeVisible();
  await expect.poll(aligned).toBeLessThan(2);
  expect(await page.evaluate(() => window.scrollY)).toBe(outerY);
  const liked = panel.getByRole('button', { name: '«Песня 15» — в понравившиеся', exact: true });
  await liked.click();
  await expect(panel.getByRole('button', { name: 'Убрать «Песня 15» из понравившихся' })).toHaveAttribute('aria-pressed', 'true');
  expect(await page.evaluate(() => window.player.getListenState().track.title)).toBe('Песня 14');
  await page.screenshot({ path: testInfo.outputPath('player-queue.png'), fullPage: true });
  const disclosure = page.getByRole('button', { name: /Далее/ });
  await disclosure.focus();
  await page.keyboard.press('Enter');
  await expect(disclosure).toHaveAttribute('aria-expanded', 'false');
  await expect(panel).toBeHidden();
  await page.evaluate(() => window.player.next());
  await page.keyboard.press('Enter');
  await expect(disclosure).toHaveAttribute('aria-expanded', 'true');
  await expect.poll(aligned).toBeLessThan(2);
  await page.evaluate(() => window.player.playQueueAt(29));
  await expect.poll(aligned).toBeLessThan(2);
  await expect(current.getByText('Песня 30', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await expect(page.getByRole('button', { name: 'Аудиовыход', exact: true }).first()).toBeVisible();
  await expect(queue).toBeVisible();
});
