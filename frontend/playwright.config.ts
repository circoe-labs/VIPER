import { defineConfig, devices } from '@playwright/test'

import { BACKEND_DIR, E2E_API_PORT, E2E_DATABASE_URL, E2E_WEB_PORT, PYTHON } from './e2e/env'

const BASE_URL = `http://localhost:${String(E2E_WEB_PORT)}`

// Full stack: the real backend on the dedicated `viper_e2e` database, behind a Vite dev server, both on their own
// ports (e2e/env.ts). Global setup migrates the database and creates the E2E account. Needs PostgreSQL running.
export default defineConfig({
  testDir: './e2e',
  forbidOnly: Boolean(process.env.CI),
  reporter: 'list',
  globalSetup: './e2e/global-setup.ts',
  use: { baseURL: BASE_URL, trace: 'retain-on-failure' },
  // Every test runs on its own, in any order and alongside any other, on the one shared database: the synthetic
  // dataset is read-only and each test writes only rows it owns (e2e/data.ts, decision I-81).
  fullyParallel: true,
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: `"${PYTHON}" -m uvicorn app.main:create_app --factory --host 127.0.0.1 --port ${String(E2E_API_PORT)}`,
      cwd: BACKEND_DIR,
      env: { VIPER_DATABASE_URL: E2E_DATABASE_URL },
      url: `http://127.0.0.1:${String(E2E_API_PORT)}/api/health`,
      reuseExistingServer: !process.env.CI,
    },
    {
      command: 'npx vite --config e2e/vite.config.e2e.ts',
      url: BASE_URL,
      reuseExistingServer: !process.env.CI,
    },
  ],
})
