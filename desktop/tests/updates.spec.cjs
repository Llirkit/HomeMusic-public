const { test, expect, _electron: electron } = require('@playwright/test');
const { createServer } = require('node:http');
const { createHash } = require('node:crypto');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');

test('packaged updater downloads over HTTP, verifies SHA512, and rejects a corrupt release', async () => {
  test.skip(!process.env.HOMEMUSIC_TEST_EXECUTABLE, 'Проверка обновлений требует собранного клиента');
  const profile = mkdtempSync(path.join(tmpdir(), 'hm-update-test-'));
  const payload = Buffer.alloc(8192, 'NSIS-test-data');
  let corrupt = false;
  const server = createServer((request, response) => {
    const version = corrupt ? '2.0.1' : '2.0.0';
    const name = `HomeMusic-Setup-${version}.exe`;
    const expected = corrupt ? Buffer.alloc(8192, 'new-release') : payload;
    const sha512 = createHash('sha512').update(expected).digest('base64');
    if (new URL(request.url, 'http://test').pathname.endsWith('/latest.yml')) {
      response.setHeader('Content-Type', 'application/yaml');
      response.end(`version: ${version}\nfiles:\n  - url: ${name}\n    sha512: ${sha512}\n    size: ${payload.length}\npath: ${name}\nsha512: ${sha512}\n`);
    } else {
      const bytes = Buffer.from(expected);
      if (corrupt) bytes[0] ^= 255;
      response.end(bytes);
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let app;
  try {
    app = await electron.launch({ executablePath: process.env.HOMEMUSIC_TEST_EXECUTABLE, args: [`--user-data-dir=${profile}`] });
    await app.firstWindow();
    const run = () => app.evaluate(async ({ app }, origin) => {
      const root = app.getAppPath();
      const load = process.getBuiltinModule('module').createRequire(root + '/package.json');
      const { DesktopUpdates } = load('./src/updates.cjs');
      const { NsisUpdater } = load('electron-updater');
      let engine;
      const errors = [];
      const controller = new DesktopUpdates({ enabled: true, createUpdater: (url) => {
        engine = new NsisUpdater({ provider: 'generic', url });
        Object.defineProperty(engine.app, 'baseCachePath', { value: app.getPath('userData') + '/update-cache' });
        engine.disableDifferentialDownload = true;
        engine.logger = null;
        engine.on('error', (error) => errors.push(error.message));
        return engine;
      } });
      try {
        controller.configure(origin);
        await controller.check();
        return { ...controller.state, errors, installOnQuit: engine.autoInstallOnAppQuit,
          quitHandlerAdded: engine.quitHandlerAdded,
          downloaded: engine.installerPath ? load('node:fs').statSync(engine.installerPath).size : 0 };
      } finally {
        // Test binaries are never executed; all cache files belong to this temporary profile.
        controller.dispose();
      }
    }, origin);
    const ready = await run();
    expect(ready.errors).toEqual([]);
    expect(ready).toMatchObject({ phase: 'ready', version: '2.0.0', percent: 100, installOnQuit: true, quitHandlerAdded: true, downloaded: payload.length });
    corrupt = true;
    expect(await run()).toMatchObject({ phase: 'error', installOnQuit: false, downloaded: 0 });
  } finally {
    await app?.close();
    await new Promise((resolve) => server.close(resolve));
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
