import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests: a real Chromium, the real UI, the real backend.
 *
 * Needs the stack up (`make up-node` from the repo root). By default the dev server is
 * started here and proxies /api to the gateway, exactly as in development.
 *
 * `E2E_BASE_URL=http://localhost:8080 npm run e2e` runs the same suite against the
 * built image behind the gateway instead — the production path, no dev server.
 */
const external = process.env.E2E_BASE_URL;

export default defineConfig({
  testDir: './e2e',
  // One worker: every test shares one database and some deliberately fight over the
  // last unit of a product.
  workers: 1,
  timeout: 60_000,
  use: {
    baseURL: external ?? 'http://localhost:5173',
    locale: 'th-TH',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: external
    ? undefined
    : {
        command: 'npx vite --port 5173 --strictPort',
        url: 'http://localhost:5173',
        reuseExistingServer: true,
      },
});
