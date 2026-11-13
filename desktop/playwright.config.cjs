const { defineConfig } = require('@playwright/test');
const { join } = require('node:path');
const { tmpdir } = require('node:os');

module.exports = defineConfig({
  testDir: './tests', testMatch: '**/*.spec.cjs', workers: 1, timeout: 45_000,
  outputDir: join(tmpdir(), `homemusic-desktop-e2e-${process.pid}`), reporter: 'list',
});
