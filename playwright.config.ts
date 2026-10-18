import { defineConfig } from '@playwright/test';

// Tests des écrans : Playwright lance la vraie application Electron (apps/desktop, déjà construite)
// sur une base vide. Sous Linux sans écran, lancer avec `xvfb-run -a npm run test:ecrans`.
export default defineConfig({
  testDir: 'apps/desktop/e2e',
  timeout: 240_000,
  workers: 1,
  reporter: [['list']],
  use: { screenshot: 'only-on-failure', trace: 'retain-on-failure' },
  outputDir: 'test-results/ecrans',
});
