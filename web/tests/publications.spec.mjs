import { test, expect } from '@playwright/test';

const song = (n) => ({ ref: `nd:s${n}`, source: 'nd', id: `s${n}`, nd_song_id: `s${n}`, title: `Песня ${n}`, artist: 'Кино', duration_s: 180, owned: true, downloading: false });
const token = 'abcdefghijklmnopqrstuvwx12345678';

async function backend(page, signedIn = true) {
  const state = { signedIn, requests: [], links: [], current: song(1), position: 42, revoked: false };
  const publication = { id: token, title: 'Дорога', kind: 'share', owner: true, active: true, source_kind: 'playlist', url: `http://127.0.0.1:5174/#/shared/${token}` };
  await page.route('**/api/**', async (route) => {
    const req = route.request(), path = new URL(req.url()).pathname;
    if (!path.startsWith('/api/')) return route.fallback();
    const json = (value, status = 200) => route.fulfill({ status, json: value });
    if (path === '/api/auth/me') return json(state.signedIn ? { id: 1, username: 'alice', is_admin: false, public_music_url: '' } : { detail: 'Требуется вход' }, state.signedIn ? 200 : 401);
    if (path === '/api/auth/options') return json({});
    if (path === '/api/auth/login') { state.signedIn = true; return json({ id: 1, username: 'alice', is_admin: false, public_music_url: '' }); }
    if (path === '/api/events') return route.fulfill({ contentType: 'text/event-stream', body: 'event: ping\ndata: {}\n\n' });
    if (path === '/api/publications' && req.method() === 'POST') {
      state.requests.push(req.postDataJSON());
      const value = { ...publication, kind: req.postDataJSON().kind };
      if (value.kind === 'radio') value.url = value.url.replace('/shared/', '/radio/');
      state.links = [value]; return json(value);
    }
    if (path === '/api/publications') return json(state.links);
    if (path.endsWith('/radio')) {
      if (state.revoked) return json({ detail: 'Ссылка недоступна или отозвана' }, 404);
      return json({ ...publication, kind: 'radio', track: state.current, position_s: state.position, duration_s: 180,
        stream_url: `/api/publications/${token}/audio/${state.current.id}?v=${state.current.ref}` });
    }
    if (path === `/api/publications/${token}` && req.method() === 'DELETE') { state.links = []; state.revoked = true; return json({ ok: true }); }
    if (path === `/api/publications/${token}`) return state.signedIn ? json({ ...publication, owner: false, tracks: [song(1), song(2)] }) : json({ detail: 'Требуется вход' }, 401);
    if (path === '/api/playlists/p1') return json({ id: 'p1', name: 'Дорога', song_count: 2, duration_s: 360, tracks: [song(1), song(2)] });
    if (path === '/api/playlists') return json([{ id: 'p1', name: 'Дорога', song_count: 2, duration_s: 360 }, { id: 'empty', name: 'Пустой', song_count: 0, duration_s: 0 }]);
    if (path === '/api/mixes/1') return json({ id: 1, title: 'Микс дня', description: 'Любимые песни', mode: 'normal', mode_title: 'Обычный', created_at: '2026-11-25T00:00:00', ready: 2, total: 2, tracks: [song(1), song(2)], generators: {} });
    if (path === '/api/mixes/today') return json({ mix: null, building: false, onboarding: false, settings: { mode: 'normal', mix_hour: 5, artists: [] } });
    if (path === '/api/starred') return json({ song_ids: [], album_ids: [], artist_ids: [], refs: [], subjects: [] });
    if (path === '/api/disliked') return json({ refs: [], artists: [], subjects: [] });
    if (path === '/api/nd/home') return json({ recent: [], frequent: [], newest: [], starred: [], radio: [] });
    return json({});
  });
  return state;
}

async function fakeMedia(page) {
  await page.addInitScript(() => {
    Object.defineProperty(HTMLMediaElement.prototype, 'currentTime', { get() { return this._position || 0; }, set(v) { this._position = v; }, configurable: true });
    Object.defineProperty(HTMLMediaElement.prototype, 'paused', { get() { return this._paused !== false; }, configurable: true });
    Object.defineProperty(HTMLMediaElement.prototype, 'readyState', { get() { return 4; }, configurable: true });
    HTMLMediaElement.prototype.load = function () { queueMicrotask(() => this.dispatchEvent(new Event('loadedmetadata'))); };
    HTMLMediaElement.prototype.play = function () { this._paused = false; this.dispatchEvent(new Event('playing')); return Promise.resolve(); };
    HTMLMediaElement.prototype.pause = function () { this._paused = true; this.dispatchEvent(new Event('pause')); };
  });
}

test('share playlist, copy its link, close with Escape and create public radio', async ({ page }) => {
  const state = await backend(page);
  await page.goto('/#/playlist/p1');
  await page.getByRole('button', { name: 'Поделиться', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Поделиться музыкой' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('textbox', { name: 'Ссылка', exact: true })).toHaveValue(/\/shared\//);
  await dialog.getByRole('button', { name: 'Копировать ссылку' }).click();
  await expect(page.getByText('Ссылка скопирована', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole('button', { name: 'Поделиться', exact: true })).toBeFocused();
  await page.getByRole('button', { name: 'Создать онлайн-радио' }).click();
  await expect(page.getByRole('dialog', { name: 'Радио создано' })).toBeVisible();
  expect(state.requests).toEqual([{ kind: 'share', source_kind: 'playlist', source_id: 'p1' }, { kind: 'radio', source_kind: 'playlist', source_id: 'p1' }]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('daily mix offers radio next to sharing and creates a station from the mix', async ({ page }) => {
  const state = await backend(page);
  await page.goto('/#/mix/1');
  await expect(page.getByRole('button', { name: 'Поделиться', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Создать онлайн-радио', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Радио создано' })).toBeVisible();
  expect(state.requests).toEqual([{ kind: 'radio', source_kind: 'mix', source_id: '1' }]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('playlist list offers radio directly, while an empty playlist cannot start a station', async ({ page }) => {
  const state = await backend(page);
  await page.goto('/#/playlists');
  const road = page.getByRole('listitem').filter({ has: page.getByRole('link', { name: /Дорога/ }) });
  const empty = page.getByRole('listitem').filter({ has: page.getByRole('link', { name: /Пустой/ }) });
  await expect(empty.getByRole('button', { name: 'Создать онлайн-радио' })).toBeDisabled();
  await road.getByRole('button', { name: 'Создать онлайн-радио' }).click();
  await expect(page.getByRole('dialog', { name: 'Радио создано' })).toBeVisible();
  expect(state.requests).toEqual([{ kind: 'radio', source_kind: 'playlist', source_id: 'p1' }]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('shared collection preserves its address through login and has no owner controls', async ({ page }) => {
  await backend(page, false);
  await page.goto(`/#/shared/${token}`);
  await page.getByLabel('Имя или почта', { exact: true }).fill('bob');
  await page.getByLabel('Пароль', { exact: true }).fill('pw');
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Слушать всё', exact: true })).toBeVisible();
  await expect(page.getByText('Песня 1', { exact: true })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/shared/${token}`));
  await expect(page.getByRole('button', { name: 'Удалить плейлист' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Управлять ссылкой' })).toHaveCount(0);
});

test('guest joins current radio position, follows song change and disconnects after revoke', async ({ page }) => {
  await fakeMedia(page);
  const state = await backend(page, false);
  await page.goto(`/#/radio/${token}`);
  await expect(page.getByRole('heading', { name: 'Дорога', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Слушать эфир', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Отключиться от эфира' })).toBeVisible();
  expect(await page.locator('audio').evaluate((a) => a.currentTime)).toBeGreaterThanOrEqual(42);
  state.current = song(2); state.position = 3;
  await expect(page.getByRole('heading', { name: 'Песня 2', exact: true })).toBeVisible({ timeout: 10000 });
  expect(await page.locator('audio').evaluate((a) => a.currentTime)).toBeLessThan(8);
  state.revoked = true;
  await expect(page.getByText('Ссылка недоступна или отозвана', { exact: true })).toBeVisible({ timeout: 10000 });
  expect(await page.locator('audio').evaluate((a) => a.paused)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('owner revokes a publication from management page', async ({ page }) => {
  const state = await backend(page);
  state.links = [{ id: token, title: 'Дорога', kind: 'share', owner: true, url: 'https://music.test/#/shared/example' }];
  await page.goto('/#/publications');
  await page.getByRole('button', { name: 'Отозвать ссылку', exact: true }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Отозвать', exact: true }).click();
  await expect(page.getByText('Пока нет ссылок', { exact: true })).toBeVisible();
  expect(state.revoked).toBe(true);
});

test('Android radio uses the native service and does not start HTML audio', async ({ page }) => {
  await page.addInitScript(() => {
    window.radioCommands = [];
    window.SpotikRadio = { command: (json) => window.radioCommands.push(JSON.parse(json)) };
  });
  await backend(page, false);
  await page.goto(`/#/radio/${token}`);
  await page.getByRole('button', { name: 'Слушать эфир', exact: true }).click();
  expect(await page.evaluate(() => window.radioCommands.at(-1))).toEqual({ op: 'radio', id: `radio:${token}`, token });
  await page.evaluate((id) => window.hmAndroidRadio({ id, state: 3, playing: true, playWhenReady: true }), `radio:${token}`);
  await page.getByRole('button', { name: 'Отключиться от эфира' }).click();
  expect(await page.evaluate(() => window.radioCommands.at(-1).op)).toBe('stop');
  await expect(page.locator('audio')).not.toHaveAttribute('src');
});

test('Windows radio toolbar toggles the broadcast without next and previous commands', async ({ page }) => {
  await fakeMedia(page);
  await page.addInitScript(() => {
    window.desktopStates = [];
    const listeners = new Set();
    window.HomeMusicDesktop = { updatePlayer: (s) => window.desktopStates.push(s), onCommand: (fn) => { listeners.add(fn); return () => listeners.delete(fn); } };
    window.toolbarCommand = (command) => { for (const fn of listeners) fn(command); };
  });
  await backend(page, false);
  await page.goto(`/#/radio/${token}`);
  await page.getByRole('button', { name: 'Слушать эфир', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.desktopStates.at(-1))).toMatchObject({ active: true, playing: true, canNext: false, canPrevious: false, title: 'Песня 1' });
  await page.evaluate(() => window.toolbarCommand('toggle'));
  await expect(page.getByRole('button', { name: 'Слушать эфир', exact: true })).toBeVisible();
  await page.evaluate(() => window.toolbarCommand('toggle'));
  await expect(page.getByRole('button', { name: 'Отключиться от эфира', exact: true })).toBeVisible();
});
