import { test, expect } from '@playwright/test';

async function setup(page, options = {}) {
  const requests = [];
  await page.route('**/audio-test', route => route.fulfill({ contentType: 'text/html', body: '<html lang="ru"><body><div id="root"></div></body></html>' }));
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    if (!url.pathname.startsWith('/api/')) return route.fallback();
    if (url.pathname === '/api/listen/stream') {
      requests.push({ ref: url.searchParams.get('ref'), ahead: route.request().headers()['x-homemusic-prefetch'] });
      if (options.stream) return options.stream(route);
      return route.fulfill({ contentType: 'audio/wav', body: Buffer.alloc(128, 1) });
    }
    return route.fulfill({ json: { kind: 'full', duration_s: 180, song_ids: [], album_ids: [] } });
  });
  await page.addInitScript(({ unsupported, webAudio, saved, holdRestore }) => {
    window.sinks = []; window.blobs = []; window.revoked = []; window.testAudio = [];
    const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = blob => { const url = create(blob); window.blobs.push(url); return url; };
    URL.revokeObjectURL = url => { window.revoked.push(url); revoke(url); };
    const devices = new EventTarget();
    window.outputs = [{ kind: 'audiooutput', deviceId: 'headphones', label: 'Наушники USB' },
      { kind: 'audiooutput', deviceId: 'broken', label: 'Недоступное устройство' }];
    devices.enumerateDevices = async () => window.outputs;
    Object.defineProperty(navigator, 'mediaDevices', { value: devices, configurable: true });
    Object.defineProperty(HTMLMediaElement.prototype, 'setSinkId', { configurable: true,
      value: unsupported ? undefined : async function (id) { window.sinks.push(id); } });
    window.Audio = class extends EventTarget {
      currentTime = 0; duration = 180; readyState = 4; paused = true; ended = false; src = ''; volume = 1;
      constructor() { super(); window.testAudio.push(this); }
      play() { this.paused = false; this.dispatchEvent(new Event('playing')); return Promise.resolve(); }
      pause() { this.paused = true; this.dispatchEvent(new Event('pause')); }
      load() {}
      getAttribute(name) { return name === 'src' ? this.src : null; }
      removeAttribute() { this.src = ''; }
      async setSinkId(id) {
        window.sinks.push(id);
        if (holdRestore && id === 'headphones') await new Promise(resolve => { window.releaseOutput = resolve; });
        if (id === 'broken') throw new Error('NotFoundError');
      }
    };
    if (saved) localStorage.setItem('hm-audio-output', saved);
    if (webAudio) {
      const match = window.matchMedia.bind(window);
      window.matchMedia = query => query.includes('pointer: fine') ? { matches: true } : match(query);
      window.contextSinks = [];
      window.AudioContext = class extends EventTarget {
        state = 'running';
        async setSinkId(id) { window.contextSinks.push(id); }
        createAnalyser() { return { connect() {}, fftSize: 1024 }; }
        createMediaElementSource() { return { connect() {} }; }
        async resume() {} async close() { this.state = 'closed'; }
      };
    }
  }, { unsupported: options.unsupported ?? false, webAudio: options.webAudio ?? false, saved: options.saved ?? '', holdRestore: options.holdRestore ?? false });
  await page.goto('/audio-test');
  await page.evaluate(async () => {
    const refresh = (await import('/@react-refresh')).default;
    refresh.injectIntoGlobalHook(window);
    window.$RefreshReg$ = () => {};
    window.$RefreshSig$ = () => type => type;
    window.__vite_plugin_react_preamble_installed__ = true;
    window.player = await import('/src/lib/listen.ts');
    const React = (await import('/node_modules/.vite/deps/react.js')).default;
    const { createRoot } = (await import('/node_modules/.vite/deps/react-dom_client.js')).default;
    const { AudioOutputButton } = await import('/src/components/AudioOutput.tsx');
    createRoot(document.getElementById('root')).render(React.createElement(AudioOutputButton));
    window.tracks = [1, 2, 3].map(n => ({ ref: `test:${n}`, title: `Песня ${n}`, artist: 'Исполнитель' }));
    window.player.listenAll(window.tracks, { shuffle: false });
  });
  return requests;
}

test('loads only the next audio, reuses its bytes on advance and frees blobs on stop', async ({ page }) => {
  const requests = await setup(page);
  await expect.poll(() => page.evaluate(() => window.blobs.length)).toBe(1);
  expect(requests).toEqual([{ ref: 'test:2', ahead: '1' }]);
  expect(await page.evaluate(() => window.player.getListenState().track.ref)).toBe('test:1');
  await page.evaluate(() => window.player.next());
  expect(await page.evaluate(() => window.player.listenAudio().src)).toMatch(/^blob:/);
  await expect.poll(() => page.evaluate(() => window.blobs.length)).toBe(2);
  expect(requests.map(r => r.ref)).toEqual(['test:2', 'test:3']);
  expect(await page.evaluate(() => window.testAudio.length)).toBe(1);
  await page.evaluate(() => window.player.stopListening());
  expect(await page.evaluate(() => window.revoked.sort())).toEqual(await page.evaluate(() => window.blobs.sort()));
});

test('queue edits discard stale bytes; early skip and failed preload keep normal playback', async ({ page }) => {
  const requests = await setup(page);
  await expect.poll(() => page.evaluate(() => window.blobs.length)).toBe(1);
  await page.evaluate(() => window.player.removeFromQueue(1));
  await expect.poll(() => page.evaluate(() => window.blobs.length)).toBe(2);
  expect(await page.evaluate(() => window.revoked.length)).toBe(1);
  await page.evaluate(() => window.player.next());
  expect(await page.evaluate(() => window.player.getListenState().track.ref)).toBe('test:3');
  expect(await page.evaluate(() => window.player.listenAudio().src)).toMatch(/^blob:/);
  expect(requests.map(r => r.ref)).toEqual(['test:2', 'test:3']);
  await page.evaluate(() => window.player.stopListening());
  await page.route('**/api/listen/stream?**', route => route.fulfill({ status: 503, body: 'unavailable' }));
  await page.evaluate(() => window.player.listenAll(window.tracks, { shuffle: false }));
  await page.evaluate(() => window.player.next());
  expect(await page.evaluate(() => window.player.listenAudio().src)).toContain('/api/listen/stream?');
  expect(await page.evaluate(() => window.player.getListenState().phase)).toBe('playing');
});

test('large files are not retained and repeat-all prepares the first song at the queue end', async ({ page }) => {
  await setup(page, { stream: route => route.fulfill({ contentType: 'audio/wav', headers: { 'content-length': '40000000' }, body: 'oversized' }) });
  await page.evaluate(() => window.player.cycleRepeat());
  await page.evaluate(() => window.player.playQueueAt(2));
  await expect.poll(() => page.evaluate(() => window.player.getListenState().repeat)).toBe('all');
  expect(await page.evaluate(() => window.blobs)).toEqual([]);
  await page.evaluate(() => window.player.next());
  expect(await page.evaluate(() => window.player.getListenState().track.ref)).toBe('test:1');
  expect(await page.evaluate(() => window.player.listenAudio().src)).toContain('/api/listen/stream?');
});

test('output selection survives tracks, recovers from errors and unplugging, and the sheet supports keyboard exit', async ({ page }) => {
  await setup(page);
  const button = page.getByRole('button', { name: 'Аудиовыход', exact: true });
  await button.click();
  const select = page.getByLabel('Устройство', { exact: true });
  await expect(select.locator('option')).toHaveCount(3);
  await select.selectOption('headphones');
  await expect(select).toHaveValue('headphones');
  expect(await page.evaluate(() => localStorage.getItem('hm-audio-output'))).toBe('headphones');
  await page.evaluate(() => window.player.next());
  await expect(select).toHaveValue('headphones');
  await select.selectOption('broken');
  await expect(page.getByRole('alert')).toContainText('Не удалось переключить');
  await expect(select).toHaveValue('headphones');
  await page.evaluate(() => { window.outputs = []; navigator.mediaDevices.dispatchEvent(new Event('devicechange')); });
  await expect(select).toHaveValue('');
  expect(await page.evaluate(() => window.sinks.at(-1))).toBe('');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(button).toBeFocused();
});

test('unsupported browsers explain system output settings without a broken selector', async ({ page }) => {
  await setup(page, { unsupported: true });
  await page.getByRole('button', { name: 'Аудиовыход', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('не поддерживает выбор аудиовыхода');
  await expect(page.getByRole('combobox')).toHaveCount(0);
});

test('restores the chosen output and switches the loudness AudioContext together with the player', async ({ page }) => {
  await setup(page, { webAudio: true, saved: 'headphones' });
  await expect.poll(() => page.evaluate(() => window.sinks.includes('headphones'))).toBe(true);
  await page.evaluate(async () => {
    const audio = window.player.listenAudio();
    // The fake audio has not fetched a URL, unlike a real media element whose src is absolute.
    audio.src = new URL(audio.src, location.href).href;
    await (await import('/src/lib/waveAudio.ts')).attachLoudness(audio);
  });
  expect(await page.evaluate(() => window.contextSinks.at(-1))).toBe('headphones');
  await page.getByRole('button', { name: 'Аудиовыход', exact: true }).click();
  const select = page.getByLabel('Устройство', { exact: true });
  await select.selectOption('');
  await expect(select).toHaveValue('');
  expect(await page.evaluate(() => window.contextSinks.at(-1))).toBe('');
});

test('restores the output before sound starts and honours a pause while the device is opening', async ({ page }) => {
  await setup(page, { saved: 'headphones', holdRestore: true });
  expect(await page.evaluate(() => window.player.listenAudio().paused)).toBe(true);
  await page.evaluate(() => { window.player.pause(); window.releaseOutput(); });
  await expect.poll(() => page.evaluate(() => window.player.getListenState().phase)).toBe('paused');
  expect(await page.evaluate(() => window.player.listenAudio().paused)).toBe(true);
  await page.evaluate(() => window.player.toggle());
  await expect.poll(() => page.evaluate(() => window.player.getListenState().phase)).toBe('playing');
});
