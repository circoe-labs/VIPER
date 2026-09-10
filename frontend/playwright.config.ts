import { defineConfig, devices } from '@playwright/test'

import { BACKEND_DIR, E2E_API_PORT, E2E_DATABASE_URL, E2E_WEB_PORT, PYTHON } from './e2e/env'

const BASE_URL = `http://localhost:${String(E2E_WEB_PORT)}`
// Specs creating companies (Task 07).
const COMPANY_WRITES = /companies\.spec\.ts/

// Full stack: the real backend on the dedicated `viper_e2e` database, behind a Vite dev server, both on their own
// ports (e2e/env.ts). Global setup migrates the database and creates the E2E account. Needs PostgreSQL running.
export default defineConfig({
  testDir: './e2e',
  forbidOnly: Boolean(process.env.CI),
  reporter: 'list',
  globalSetup: './e2e/global-setup.ts',
  use: { baseURL: BASE_URL, trace: 'retain-on-failure' },
  projects: [
    { name: 'chromium', testIgnore: COMPANY_WRITES, use: { ...devices['Desktop Chrome'] } },
    // Runs once the others are done: database.spec.ts counts the synthetic dataset's companies and their audit events.
    { name: 'company-writes', testMatch: COMPANY_WRITES, dependencies: ['chromium'], use: { ...devices['Desktop Chrome'] } },
  ],
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
