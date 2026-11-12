import { expect, test } from '@playwright/test';

// Real frontend interactions; network contracts are isolated from production Navidrome and paid APIs.
async function backend(page, { authenticated = true } = {}) {
  const user = (name) => ({ id: name === 'alice' ? 1 : 2, username: name, is_admin: false, public_music_url: '', public_hub_url: '' });
  const state = { me: authenticated ? user('alice') : null, holdReply: null, lastUpload: null, rebuildRequests: 0,
    today: { mix: null, building: false, onboarding: false, settings: { mode: 'normal', mix_hour: 5, timezone: 'Asia/Tomsk', artists: [] } }, mixes: {} };
  const stats = { tracks: 2, owned: 0, to_download: 2, est_bytes: 1000, free_bytes: 1000000,
    pending: 2, exact: 0, probable: 0, not_found: 0, waiting: 0, downloading: 0, done: 0, failed: 0 };
  state.imp = { id: 71, source: 'text', method: 'file', status: 'preview', mode: 'economy', has_token: false,
    keep_token: false, download_albums: false, stats, collections: [{ id: 72, kind: 'playlist', title: 'Дорога', selected: true, count: 2, owned: 0 }],
    created_at: '2026-11-12T10:00:00' };
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (!path.startsWith('/api/')) return route.fallback();
    const json = (body, status = 200) => route.fulfill({ status, json: body });
    if (path === '/api/auth/options') return json({ invites: true, email_signup: false });
    if (path === '/api/auth/me') return json(state.me ?? { detail: 'Требуется вход' }, state.me ? 200 : 401);
    if (path === '/api/auth/login') { state.me = user(request.postDataJSON().username); return json(state.me); }
    if (path === '/api/auth/logout') { state.me = null; return json({ ok: true }); }
    if (path === '/api/events') return route.fulfill({ contentType: 'text/event-stream', body: 'event: ping\ndata: {}\n\n' });
    if (path === '/api/assistant/chat') {
      if (state.holdReply) await state.holdReply;
      return json({ chat_id: 11, reply: 'Поздний личный ответ Alice', actions: [], done: [] }).catch(() => {});
    }
    if (path === '/api/assistant/chats/11') {
      return state.me?.id === 1
        ? json({ id: 11, title: 'Личный чат', messages: [{ role: 'user', content: 'Секрет Alice' }], created_at: '2026-11-12T10:00:00', updated_at: '2026-11-12T10:00:00' })
        : json({ detail: 'Чат не найден' }, 404);
    }
    if (path === '/api/imports/text') {
      state.lastUpload = { filename: new URL(request.url()).searchParams.get('filename'), body: request.postDataBuffer().toString('utf8') };
      if (state.lastUpload.body === 'bad') return json({ detail: 'В файле нет песен' }, 400);
      return json(state.imp);
    }
    if (path === '/api/imports/71/start') {
      state.start = request.postDataJSON();
      state.imp = { ...state.imp, status: 'running', started_at: '2026-11-12T10:01:00' };
      return json(state.imp);
    }
    if (path === '/api/imports/71') return json(state.imp);
    if (path === '/api/imports') return json([]);
    if (path === '/api/nd/home') return json({ recent: [], frequent: [], newest: [], starred: [], radio: [] });
    if (path === '/api/starred') return json({ song_ids: [], album_ids: [], artist_ids: [], refs: [], subjects: [] });
    if (path === '/api/mixes/today') return state.failMixStatus ? json({ detail: 'Нет связи' }, 503) : json(state.today);
    if (path === '/api/mixes/rebuild') {
      state.rebuildRequests++;
      state.lastMixRequest = request.postDataJSON();
      if (state.failMixBuild) return json({ detail: 'Не удалось начать сборку' }, 503);
      if (state.holdMixBuild) await state.holdMixBuild;
      state.today = { ...state.today, building: true };
      return json({ queued: true });
    }
    if (/^\/api\/mixes\/\d+$/.test(path)) return json(state.mixes[path.split('/').at(-1)] ?? { detail: 'Не найдено' }, state.mixes[path.split('/').at(-1)] ? 200 : 404);
    return json([]);
  });
  return state;
}

async function login(page, username = 'bob') {
  await page.getByRole('textbox', { name: 'Имя или почта' }).fill(username);
  await page.getByLabel('Пароль', { exact: true }).fill('test-password');
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await expect(page.getByRole('navigation', { name: 'Разделы' })).toBeVisible();
}

async function logout(page) {
  await page.locator('a[href="#/more"]').click();
  await page.getByRole('button', { name: 'Выйти', exact: true }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Выйти', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Имя или почта' })).toBeVisible();
}

test('logout isolates messages, screenshot URLs and delayed replies; same-account navigation retains chat', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const state = await backend(page);
  await page.addInitScript(() => {
    window.revoked = [];
    const revoke = URL.revokeObjectURL.bind(URL);
    URL.revokeObjectURL = (url) => { window.revoked.push(url); revoke(url); };
  });
  await page.goto('/#/assistant?chat=11');
  await expect(page.getByText('Секрет Alice', { exact: true })).toBeVisible();
  await page.locator('a[href="#/more"]').click();
  await page.locator('a[href="#/assistant"]').first().click();
  await expect(page.getByText('Секрет Alice', { exact: true })).toBeVisible();
  let release;
  state.holdReply = new Promise((resolve) => { release = resolve; });
  await page.locator('input[type=file]').setInputFiles({ name: 'private.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6S8AAAAASUVORK5CYII=', 'base64') });
  await page.getByRole('textbox', { name: 'Сообщение ассистенту' }).fill('Личное сообщение Alice');
  await page.getByRole('button', { name: 'Отправить', exact: true }).click();
  await expect(page.getByText('Личное сообщение Alice', { exact: true })).toBeVisible();
  const imageURL = await page.locator('img[alt="Скриншот"]').getAttribute('src');
  await logout(page);
  await login(page);
  release();
  await page.locator('a[href="#/more"]').click();
  await page.locator('a[href="#/assistant"]').first().click();
  await expect(page.getByText('Секрет Alice', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Личное сообщение Alice', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Поздний личный ответ Alice', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Сообщение ассистенту' })).toHaveValue('');
  expect(await page.evaluate(() => sessionStorage.getItem('hm.chat.current.1'))).toBeNull();
  expect(await page.evaluate((url) => window.revoked.includes(url), imageURL)).toBe(true);
  expect(errors).toEqual([]);
});

test('401 clears the private conversation before the next login', async ({ page }) => {
  const state = await backend(page);
  await page.goto('/#/assistant?chat=11');
  await expect(page.getByText('Секрет Alice', { exact: true })).toBeVisible();
  await page.route('**/api/imports', (route) => state.me?.id === 1
    ? route.fulfill({ status: 401, json: { detail: 'Сессия истекла' } }) : route.fallback());
  await page.locator('a[href="#/more"]').click();
  await page.getByRole('link', { name: /Перенести музыку/ }).click();
  await login(page);
  await page.locator('a[href="#/more"]').click();
  await page.locator('a[href="#/assistant"]').first().click();
  await expect(page.getByText('Секрет Alice', { exact: true })).toHaveCount(0);
});

test('cold share survives login and prepares a private draft without sending it', async ({ page }) => {
  await backend(page, { authenticated: false });
  await page.goto('/#/share');
  await page.evaluate(async () => {
    const request = indexedDB.open('homemusic-share', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('shares');
    const db = await new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = reject; });
    await new Promise((resolve, reject) => {
      const tx = db.transaction('shares', 'readwrite');
      tx.objectStore('shares').put({ text: 'Новый список для Bob', title: '', url: '', files: [], ts: Date.now() }, 'pending');
      tx.oncomplete = resolve; tx.onerror = reject;
    });
    db.close();
  });
  await login(page);
  await expect(page.getByRole('textbox', { name: 'Сообщение ассистенту' })).toHaveValue('Новый список для Bob');
  await expect(page.getByRole('button', { name: 'Отправить', exact: true })).toBeEnabled();
});

test('a delayed history load and an old deep link cannot expose another account', async ({ page }) => {
  const state = await backend(page);
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const requested = [];
  await page.route('**/api/assistant/chats/12', async (route) => {
    requested.push(true);
    await held;
    await route.fulfill({ json: { id: 12, messages: [{ role: 'user', content: 'Старая история Alice' }] } }).catch(() => {});
  });
  await page.goto('/#/assistant?chat=12');
  await expect.poll(() => requested.length).toBeGreaterThan(0);
  await logout(page);
  await login(page);
  release();
  await page.locator('a[href="#/more"]').click();
  await page.locator('a[href="#/assistant"]').first().click();
  await expect(page.getByText('Старая история Alice', { exact: true })).toHaveCount(0);
  await page.evaluate(() => { window.location.hash = '/assistant?chat=11'; });
  await expect(page.getByText('Чат не найден', { exact: true })).toBeVisible();
  await expect(page.getByText('Секрет Alice', { exact: true })).toHaveCount(0);
  expect(state.me.username).toBe('bob');
});

for (const format of ['TXT', 'CSV']) test(`${format} upload shows preview, requires confirmation, handles errors and preserves other import options`, async ({ page }) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const state = await backend(page);
  await page.goto('/#/import');
  await expect(page.getByRole('heading', { name: 'Перенести музыку', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Войти через Яндекс' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Загрузить экспорт Spotify' })).toBeAttached();
  await page.screenshot({ path: test.info().outputPath('text-import.png'), fullPage: true });
  await page.getByLabel('Список песен TXT или CSV', { exact: true }).setInputFiles({ name: 'big.txt', mimeType: 'text/plain', buffer: Buffer.alloc(1024 * 1024 + 1) });
  await expect(page.getByText('Текстовый файл превышает 1 МБ', { exact: true })).toBeVisible();
  expect(state.lastUpload).toBeNull();
  await page.getByLabel('Список песен TXT или CSV', { exact: true }).setInputFiles({ name: 'Дорога.txt', mimeType: 'text/plain', buffer: Buffer.from('bad') });
  await expect(page.getByText('В файле нет песен', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Загрузить TXT или CSV' })).toBeEnabled();
  const body = format === 'CSV' ? 'Track Name,Artist Name(s),Album Name,Duration (ms)\nГруппа крови,Кино,Группа крови,246000\nОсень,ДДТ,,260000' : 'Кино — Группа крови\nДДТ — Осень';
  const filename = `Дорога.${format.toLowerCase()}`;
  await page.getByLabel('Список песен TXT или CSV', { exact: true }).setInputFiles({ name: filename, mimeType: format === 'CSV' ? 'text/csv' : 'text/plain', buffer: Buffer.from(body) });
  await expect(page.getByText('Дорога', { exact: true })).toBeVisible();
  expect(state.lastUpload).toEqual({ filename, body });
  expect(state.start).toBeUndefined();
  await expect(page.getByText('Запомнить вход, чтобы потом подтянуть новое')).toHaveCount(0);
  const confirm = page.getByRole('button', { name: 'Перенести', exact: true });
  await page.screenshot({ path: test.info().outputPath('text-preview.png'), fullPage: true });
  await confirm.focus();
  await expect(confirm).toBeFocused();
  await page.keyboard.press('Enter');
  await expect.poll(() => state.start).toMatchObject({ collection_ids: [72], mode: 'economy' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});

const sampleMix = (id) => ({ id, title: `Микс ${id}`, description: 'Песни по вашему вкусу', mode: 'normal', mode_title: 'Обычный',
  tracks: [], total: 0, ready: 0, created_at: '2026-11-12T12:00:00', status: 'active' });

test('regular user starts the first daily mix now; loading blocks duplicate clicks and completed mix appears', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const state = await backend(page);
  let release;
  state.holdMixBuild = new Promise((resolve) => { release = resolve; });
  await page.clock.install();
  await page.goto('/#/home');
  const button = page.getByRole('button', { name: 'Собрать микс сейчас', exact: true });
  await button.focus();
  await expect(button).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: 'Собирается…', exact: true })).toBeDisabled();
  expect(state.rebuildRequests).toBe(1);
  expect(state.lastMixRequest).toEqual({});
  release();
  await expect(page.getByRole('status').filter({ hasText: 'Собираем «Микс дня»' })).toBeVisible();
  state.today = { ...state.today, building: false, mix: sampleMix(1) };
  state.mixes[1] = state.today.mix;
  await page.clock.fastForward(8500);
  await expect(page.getByRole('link', { name: 'Микс дня: Микс 1' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Собрать заново', exact: true })).toBeEnabled();
  await page.screenshot({ path: test.info().outputPath('manual-mix.png'), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});

test('mix card preserves current playback link and allows retry after request or build failure', async ({ page }) => {
  const state = await backend(page);
  state.today.mix = sampleMix(1);
  state.mixes[1] = state.today.mix;
  state.failMixBuild = true;
  await page.clock.install();
  await page.goto('/#/home');
  await page.getByRole('button', { name: 'Собрать заново', exact: true }).click();
  await expect(page.getByText('Не удалось начать сборку', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Собрать заново', exact: true })).toBeEnabled();
  state.failMixBuild = false;
  await page.getByRole('button', { name: 'Собрать заново', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Собираем новый микс' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Микс дня: Микс 1' })).toBeVisible();
  state.today = { ...state.today, building: false };
  await page.clock.fastForward(8500);
  await expect(page.getByText('Новый микс не появился. Попробуйте собрать ещё раз.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Собрать заново', exact: true })).toBeEnabled();
});

test('new user is guided to pick artists before creating a mix', async ({ page }) => {
  const state = await backend(page);
  state.today.onboarding = true;
  await page.goto('/#/home');
  const setup = page.getByRole('link', { name: /Что вы слушаете/ });
  await expect(setup).toHaveAttribute('href', '#/taste');
  await expect(page.getByRole('button', { name: 'Собрать микс сейчас', exact: true })).toHaveCount(0);
  expect(state.rebuildRequests).toBe(0);
});

test('regular user rebuilds from mix detail and reaches the new mix when it finishes', async ({ page }) => {
  const state = await backend(page);
  state.today.mix = sampleMix(1);
  state.mixes[1] = state.today.mix;
  state.mixes[2] = sampleMix(2);
  await page.clock.install();
  await page.goto('/#/mix/1');
  await page.getByRole('button', { name: 'Собрать заново', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Собирается…', exact: true })).toBeDisabled();
  state.today = { ...state.today, mix: state.mixes[2], building: false };
  await page.clock.fastForward(4500);
  await expect(page.getByRole('heading', { name: 'Микс 2', exact: true })).toBeVisible();
  expect(state.rebuildRequests).toBe(1);
});
