import { test, expect } from '@playwright/test';

const timed = (ref) => ({ ref, status: 'found', plain: 'Первая строка\nВторая строка', synced: true,
  duration_s: 180, source: 'LRCLIB', source_url: 'https://lrclib.net',
  lines: [{ start_ms: 1000, text: 'Первая строка' }, { start_ms: 4000, text: '' }, { start_ms: 6000, text: 'Вторая строка' }] });

async function setup(page, answer = (route) => route.fulfill({ json: timed(new URL(route.request().url()).searchParams.get('ref')) })) {
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
  await page.route('**/api/**', (route) => {
    const url = new URL(route.request().url());
    if (!url.pathname.startsWith('/api/')) return route.fallback();
    if (url.pathname === '/api/lyrics') return answer(route);
    if (url.pathname === '/api/auth/me') return route.fulfill({ json: { id: 1, username: 'alice', is_admin: false } });
    if (url.pathname === '/api/listen') return route.fulfill({ json: { ref: url.searchParams.get('ref'), kind: 'full', duration_s: 180 } });
    if (url.pathname === '/api/events') return route.fulfill({ contentType: 'text/event-stream', body: '' });
    if (url.pathname === '/api/starred') return route.fulfill({ json: { song_ids: [], refs: [], subjects: [] } });
    return route.fulfill({ json: {} });
  });
  await page.goto('/#/player');
  await page.evaluate(async () => {
    window.player = await import('/src/lib/listen.ts');
    window.tracks = [1, 2].map((id) => ({ ref: `dz:${id}`, title: `Песня ${id}`, artist: 'Исполнитель с длинным русским именем', duration_s: 180 }));
    window.player.listen(window.tracks[0], window.tracks);
  });
  await expect(page.getByRole('button', { name: 'Текст песни', exact: true }).first()).toBeVisible();
}

test('lyrics follow playback, seek by line, switch to plain text and retain player controls', async ({ page }, testInfo) => {
  await setup(page);
  await page.getByRole('button', { name: 'Текст песни', exact: true }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Текст песни' });
  const first = dialog.getByRole('button', { name: 'Перейти к строке: Первая строка' });
  const second = dialog.getByRole('button', { name: 'Перейти к строке: Вторая строка' });
  await expect(dialog.getByRole('button', { name: 'Синхронизация: включена' })).toHaveAttribute('aria-pressed', 'true');
  await page.evaluate(() => { window.player.listenAudio().currentTime = 2; window.player.listenAudio().dispatchEvent(new Event('timeupdate')); });
  await expect(first).toHaveAttribute('aria-current', 'true');
  await second.click();
  await expect.poll(() => page.evaluate(() => window.player.listenAudio().currentTime)).toBe(6);
  await page.evaluate(() => window.player.listenAudio().dispatchEvent(new Event('timeupdate')));
  await expect(second).toHaveAttribute('aria-current', 'true');
  await page.screenshot({ path: testInfo.outputPath('lyrics.png') });
  await dialog.getByRole('button', { name: 'Синхронизация: включена' }).click();
  await expect(dialog.getByRole('button', { name: 'Синхронизация: выключена' })).toHaveAttribute('aria-pressed', 'false');
  await expect(first).toHaveCount(0);
  await expect(dialog.getByText('Первая строка\nВторая строка', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Пауза', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Слушать', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
});

test('track changes clear old lyrics while a new request is pending', async ({ page }) => {
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  await setup(page, async (route) => {
    const ref = new URL(route.request().url()).searchParams.get('ref');
    if (ref === 'dz:2') { await pending; return route.fulfill({ json: { ...timed(ref), plain: 'Новый текст', lines: [], synced: false } }); }
    return route.fulfill({ json: timed(ref) });
  });
  await page.getByRole('button', { name: 'Текст песни', exact: true }).first().click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('Первая строка', { exact: true })).toBeVisible();
  await page.evaluate(() => window.player.next());
  await expect(dialog.getByText('Первая строка', { exact: true })).toHaveCount(0);
  await expect(dialog.getByText('Ищем текст…')).toBeVisible();
  release();
  await expect(dialog.getByText('Новый текст', { exact: true })).toBeVisible();
  await expect(dialog.getByText('Текст без синхронизации', { exact: true })).toBeVisible();
});

test('unavailable, missing and instrumental states allow recovery', async ({ page }) => {
  let status = 'temporarily_unavailable';
  await setup(page, (route) => route.fulfill({ json: { ...timed('dz:1'), status } }));
  await page.getByRole('button', { name: 'Текст песни', exact: true }).first().click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText(/Источник текстов временно недоступен/)).toBeVisible();
  status = 'instrumental';
  await dialog.getByRole('button', { name: 'Повторить', exact: true }).click();
  await expect(dialog.getByText('Инструментальная композиция — без слов')).toBeVisible();
  await dialog.getByRole('button', { name: 'Закрыть текст песни' }).click();
  status = 'not_found';
  await page.getByRole('button', { name: 'Текст песни', exact: true }).first().click();
  await expect(page.getByRole('dialog').getByText(/Текст пока не найден/)).toBeVisible();
});
