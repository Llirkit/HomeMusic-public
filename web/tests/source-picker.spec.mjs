import { test, expect } from '@playwright/test';

async function backend(page) {
  const state = { posts: [], failSave: false, failSearch: false, hold: null };
  const candidate = id => ({ provider: 'hitmoz', provider_id: String(id), title: id === 1 ? 'Группа крови (live)' : 'Группа крови (студийная запись)',
    artist: 'Кино', page_url: `https://source.test/${id}`, duration_s: 245, bitrate_kbps: id === 1 ? 128 : 320 });
  const item = { id: 55, batch_id: 1, status: 'queued', progress: 0, title: 'Группа крови', artist: 'Кино', track_id: 1,
    replacing_audio: true, warnings: [], created_at: '2026-11-15T01:00:00', updated_at: '2026-11-15T01:00:00' };
  await page.addInitScript(() => {
    window.Audio = class extends EventTarget {
      currentTime = 0; duration = 245; readyState = 4; paused = true; ended = false; src = '';
      play() { this.paused = false; this.dispatchEvent(new Event('playing')); return Promise.resolve(); }
      pause() { this.paused = true; this.dispatchEvent(new Event('pause')); }
      load() {}
      getAttribute(name) { return name === 'src' ? this.src : null; }
      removeAttribute() { this.src = ''; }
    };
  });
  await page.route('**/healthz', route => route.fulfill({ json: { ok: true, capabilities: [] } }));
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (!path.startsWith('/api/')) return route.fallback();
    const json = (body, status = 200) => route.fulfill({ json: body, status });
    if (path === '/api/auth/me') return json({ id: 1, username: 'test', is_admin: false });
    if (path === '/api/events') return route.fulfill({ contentType: 'text/event-stream', body: '' });
    if (path === '/api/starred') return json({ song_ids: [], album_ids: [], refs: [], subjects: [] });
    if (path === '/api/library/tracks') return json([{ id: 1, album_id: 1, nd_song_id: 'nd0', title: 'Группа крови', artist: 'Кино', duration_s: 245 }]);
    if (path === '/api/library/track-source') return json({ track_id: 1, source: 'hitmoz', source_url: 'https://source.test/1', acquired_at: '2026-11-14T01:00:00' });
    if (path === '/api/search/providers') return state.failSearch ? json({ detail: 'Источники недоступны' }, 503) : json({ candidates: [candidate(1), candidate(2)], errors: [] });
    if (path === '/api/listen') return json({ kind: 'full', duration_s: 245 });
    if (path.endsWith('/replace-source') || path === '/api/imports/items/8/source') {
      state.posts.push({ path, body: route.request().postDataJSON() });
      if (state.hold) await state.hold;
      return state.failSave ? json({ detail: 'Источник уже изменён. Откройте выбор заново' }, 409) : json(item);
    }
    if (path === '/api/downloads/55') return json(item);
    if (path === '/api/imports/71') return json({ id: 71, source: 'text', method: 'file', status: 'done', mode: 'economy', collections: [], stats: {} });
    if (path === '/api/imports/71/items') return json({ total: 1, items: [{ id: 8, collection_id: 72, position: 0, kind: 'track', title: 'Группа крови', artist: 'Кино', match: 'exact', status: 'done', ref: 'dz:100', nd_song_id: 'nd0' }] });
    return json([]);
  });
  return state;
}

async function openLibraryPicker(page) {
  await page.goto('/#/library');
  await page.getByRole('button', { name: 'Треки', exact: true }).click();
  await page.getByRole('button', { name: 'Ещё: «Группа крови»' }).click();
  await page.getByRole('button', { name: 'Заменить аудиоисточник', exact: false }).click();
  const dialog = page.getByRole('dialog', { name: 'Выбрать аудиоисточник' });
  await expect(dialog.getByRole('list', { name: 'Варианты аудио' })).toBeVisible();
  return dialog;
}

test('saved track previews another source, confirms once and opens replacement progress', async ({ page }, testInfo) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const state = await backend(page);
  const dialog = await openLibraryPicker(page);
  await dialog.getByRole('button', { name: 'Послушать «Группа крови (студийная запись)»', exact: true }).click();
  await expect(dialog.getByRole('list').getByRole('button', { name: 'Пауза', exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Выбрать этот файл' }).nth(1).click();
  expect(state.posts).toHaveLength(0);
  await page.screenshot({ path: testInfo.outputPath('source-confirmation.png') });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  let release;
  state.hold = new Promise(resolve => { release = resolve; });
  const confirm = dialog.getByRole('button', { name: 'Подтвердить выбор аудио' });
  await confirm.click();
  await expect(confirm).toBeDisabled();
  await confirm.evaluate(button => button.click());
  await expect.poll(() => state.posts.length).toBe(1);
  release();
  await expect(page).toHaveURL(/#\/downloads\/55$/);
  expect(state.posts[0].body).toEqual({ candidate_ref: 'file:hitmoz:2', expected_acquired_at: '2026-11-14T01:00:00' });
  await expect(page.getByText(/Прежний файл остаётся доступен/)).toBeVisible();
  expect(errors).toEqual([]);
});

test('exact import offers manual audio selection and preserves its import target', async ({ page }) => {
  const state = await backend(page);
  await page.goto('/#/import/71/items?match=exact');
  await page.getByRole('button', { name: 'Сменить аудио', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Выбрать аудиоисточник' });
  await dialog.getByRole('button', { name: 'Выбрать этот файл' }).nth(1).click();
  await dialog.getByRole('button', { name: 'Подтвердить выбор аудио' }).click();
  await expect(page).toHaveURL(/#\/downloads\/55$/);
  expect(state.posts[0].path).toBe('/api/imports/items/8/source');
});

test('search errors recover; failed URL confirmation keeps the URL; Escape cancels without saving', async ({ page }) => {
  const state = await backend(page);
  state.failSearch = true;
  await page.goto('/#/library');
  await page.getByRole('button', { name: 'Треки', exact: true }).click();
  await page.getByRole('button', { name: 'Ещё: «Группа крови»' }).click();
  await page.getByRole('button', { name: 'Заменить аудиоисточник', exact: false }).click();
  const dialog = page.getByRole('dialog', { name: 'Выбрать аудиоисточник' });
  await expect(dialog.getByText('Источники недоступны')).toBeVisible();
  state.failSearch = false;
  await dialog.getByRole('button', { name: 'Повторить', exact: true }).click();
  await expect(dialog.getByRole('list', { name: 'Варианты аудио' })).toBeVisible();
  state.failSave = true;
  const url = 'https://youtube.com/watch?v=studio';
  await dialog.getByLabel('Или ссылка на другой файл').fill(url);
  await dialog.getByRole('button', { name: 'Использовать ссылку' }).click();
  await dialog.getByRole('button', { name: 'Подтвердить выбор аудио' }).click();
  await expect(page.getByText('Источник уже изменён. Откройте выбор заново')).toBeVisible();
  await dialog.getByRole('button', { name: 'К вариантам' }).click();
  await expect(dialog.getByLabel('Или ссылка на другой файл')).toHaveValue(url);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  expect(state.posts).toHaveLength(1);
});
