import { test, expect } from '@playwright/test';

test('Windows commands use the live player and follow queue edits, repeat, errors and stop', async ({ page }) => {
  await page.route('**/desktop-player-test', (route) => route.fulfill({ contentType: 'text/html', body: '<html lang="ru"><body></body></html>' }));
  await page.route('**/api/**', (route) => new URL(route.request().url()).pathname.startsWith('/api/')
    ? route.fulfill({ json: { kind: 'full', duration_s: 180 } }) : route.fallback());
  await page.addInitScript(() => {
    window.nativeStates = [];
    window.HomeMusicDesktop = {
      updatePlayer: (state) => window.nativeStates.push(state),
      onCommand: (callback) => { window.nativeCommand = callback; return () => {}; },
    };
    // Deterministic audio lifecycle; all queue and command handling is the real application code.
    window.Audio = class extends EventTarget {
      currentTime = 0; duration = 180; readyState = 4; paused = true; ended = false; src = '';
      play() { this.paused = false; this.dispatchEvent(new Event('playing')); return Promise.resolve(); }
      pause() { this.paused = true; this.dispatchEvent(new Event('pause')); }
      load() {}
      getAttribute(name) { return name === 'src' ? this.src : null; }
      removeAttribute() { this.src = ''; }
    };
  });
  await page.goto('/desktop-player-test');
  await page.evaluate(async () => {
    window.player = await import('/src/lib/listen.ts');
    const tracks = [1, 2].map((n) => ({ ref: `test:${n}`, title: `Песня ${n}`, artist: 'Исполнитель', duration_s: 180 }));
    window.testTracks = tracks;
    window.player.listen(tracks[0], tracks);
  });
  const nativeState = () => page.evaluate(() => window.nativeStates.at(-1));
  await expect.poll(nativeState).toMatchObject({ active: true, playing: true, canNext: true, title: 'Песня 1' });
  await page.evaluate(() => window.nativeCommand('toggle'));
  await expect.poll(nativeState).toMatchObject({ playing: false });
  await page.evaluate(() => window.nativeCommand('toggle'));
  await expect.poll(nativeState).toMatchObject({ playing: true });
  await page.evaluate(() => window.nativeCommand('next'));
  await expect.poll(nativeState).toMatchObject({ title: 'Песня 2', canNext: false });
  await page.evaluate(() => window.nativeCommand('previous'));
  await expect.poll(nativeState).toMatchObject({ title: 'Песня 1', canNext: true });
  await page.evaluate(() => window.player.removeFromQueue(1));
  await expect.poll(nativeState).toMatchObject({ canNext: false });
  await page.evaluate(() => window.player.addToQueue([window.testTracks[1]]));
  await expect.poll(nativeState).toMatchObject({ canNext: true });
  await page.evaluate(() => window.nativeCommand('next'));
  await expect.poll(nativeState).toMatchObject({ title: 'Песня 2', canNext: false });
  await page.evaluate(() => window.player.cycleRepeat());
  await expect.poll(nativeState).toMatchObject({ canNext: true });
  await page.evaluate(() => window.nativeCommand('next'));
  await expect.poll(nativeState).toMatchObject({ title: 'Песня 1' });
  await page.evaluate(() => window.player.listenAudio().dispatchEvent(new Event('error')));
  await expect.poll(nativeState).toMatchObject({ playing: false, active: true });
  await page.evaluate(() => window.nativeCommand('toggle'));
  await expect.poll(nativeState).toMatchObject({ playing: true });
  await page.evaluate(() => window.player.stopListening());
  await expect.poll(nativeState).toMatchObject({ active: false, playing: false, canNext: false, canPrevious: false, title: '' });
  await page.evaluate(() => window.nativeCommand('toggle'));
  expect(await page.evaluate(() => window.player.getListenState().track)).toBeNull();
});
