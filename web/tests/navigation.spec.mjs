import { test, expect } from '@playwright/test';

async function setup(page, { admin = false } = {}) {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/healthz', route => route.fulfill({ json: { ok: true, capabilities: [] } }));
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (!path.startsWith('/api/')) return route.fallback();
    const json = body => route.fulfill({ json: body });
    if (path === '/api/auth/me') return json({ id: 1, username: 'test', is_admin: admin });
    if (path === '/api/events') return route.fulfill({ contentType: 'text/event-stream', body: '' });
    if (path === '/api/nd/home') return json({ recent: [], frequent: [], newest: [], starred: [], radio: [] });
    if (path === '/api/nd/liked') return json({ songs: [], albums: [], artists: [] });
    if (path === '/api/starred') return json({ song_ids: [], album_ids: [], refs: [], subjects: [] });
    if (path === '/api/mixes/today') return json({ mix: null, building: false, onboarding: false, settings: { mode: 'normal', mix_hour: 5, timezone: 'Asia/Tomsk', artists: [] } });
    if (path === '/api/search/history') return json({ queries: [] });
    if (path === '/api/search') return json({ artists: [], albums: [], tracks: [] });
    if (path === '/api/admin/users') return json({ users: [], ai_cost_30d_usd: 0, ai_cost_usd: 0, library_tracks: 0 });
    return json([]);
  });
  await page.goto('/#/more');
  await expect(page.getByRole('navigation', { name: 'Разделы' })).toBeVisible();
  return errors;
}

const tab = (page, name) => page.getByRole('navigation', { name: 'Разделы' }).getByRole('link', { name, exact: true });

test('Ещё opens its overview after visiting import, upload and admin screens', async ({ page }, testInfo) => {
  const errors = await setup(page, { admin: true });
  for (const [label, path] of [['Перенести музыку', '/import'], ['Загрузить файлы', '/upload'], ['Пользователи и приглашения', '/admin']]) {
    await page.getByRole('main').getByRole('link').filter({ hasText: label }).first().click();
    await expect(page).toHaveURL(new RegExp(`#${path}$`));
    await tab(page, 'Главная').click();
    await expect(page).toHaveURL(/#\/home$/);
    await tab(page, 'Ещё').click();
    await expect(page).toHaveURL(/#\/more$/);
    await expect(page.getByRole('heading', { name: 'Ещё', exact: true })).toBeVisible();
  }
  const historyLength = await page.evaluate(() => history.length);
  await tab(page, 'Ещё').click();
  expect(await page.evaluate(() => history.length)).toBe(historyLength);
  await page.screenshot({ path: testInfo.outputPath('navigation-more.png') });
  expect(errors).toEqual([]);
});

test('Библиотека opens its root while nested back and browser history remain predictable', async ({ page }) => {
  const errors = await setup(page);
  await tab(page, 'Библиотека').click();
  await page.getByRole('main').getByRole('link').filter({ hasText: 'Понравившиеся' }).click();
  await expect(page).toHaveURL(/#\/liked$/);
  await page.getByRole('button', { name: 'Назад', exact: true }).click();
  await expect(page).toHaveURL(/#\/library$/);
  await page.getByRole('main').getByRole('link').filter({ hasText: 'Понравившиеся' }).click();
  await tab(page, 'Ещё').click();
  await tab(page, 'Библиотека').click();
  await expect(page).toHaveURL(/#\/library$/);
  await page.goBack();
  await expect(page).toHaveURL(/#\/more$/);
  await page.goForward();
  await expect(page).toHaveURL(/#\/library$/);
  await expect(tab(page, 'Библиотека')).toHaveAttribute('aria-current', 'page');
  expect(errors).toEqual([]);
});

test('pending search changes cannot steal a tab transition and active tab clears its search', async ({ page }) => {
  const errors = await setup(page);
  await tab(page, 'Поиск').click();
  await page.getByRole('searchbox', { name: 'Поиск', exact: true }).fill('Новый запрос');
  await tab(page, 'Загрузки').click();
  await expect(page).toHaveURL(/#\/downloads$/);
  // Wait beyond the search debounce: a departed screen must not write its URL back.
  await page.waitForTimeout(600);
  await expect(page).toHaveURL(/#\/downloads$/);
  await tab(page, 'Библиотека').click();
  const input = page.getByRole('searchbox', { name: 'Поиск по альбомам' });
  await input.fill('Проверка');
  await expect(page).toHaveURL(/#\/library\?q=/);
  await tab(page, 'Библиотека').click();
  await expect(page).toHaveURL(/#\/library$/);
  await expect(input).toHaveValue('');
  await tab(page, 'Ещё').click();
  await page.waitForTimeout(500);
  await expect(page).toHaveURL(/#\/more$/);
  expect(errors).toEqual([]);
});
