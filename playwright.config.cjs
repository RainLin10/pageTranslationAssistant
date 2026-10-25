const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests',
  testMatch: '*.spec.cjs',
  timeout: 30000,
  fullyParallel: true,
  workers: 2,
  use: { headless: true },
  projects: [{ name: 'edge', use: { channel: 'msedge' } }],
});
