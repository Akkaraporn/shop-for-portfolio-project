import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests: a real Chromium, the real UI, the real backend.
 *
 * Needs the stack up (`make up-node` from the repo root). The dev server is started
 * here and proxies /api to the gateway, exactly as in development.
 */
export default defineConfig({
  testDir: './e2e',
  // One worker: every test shares one database and some deliberately fight over the
  // last unit of a product.
  workers: 1,
  timeout: 60_000,
  use: {
    baseURL: 'http://localhost:5173',
    locale: 'th-TH',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npx vite --port 5173 --strictPort',
    url: 'http://localhost:5173',
    reuseExistingServer: true,
  },
});
