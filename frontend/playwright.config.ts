import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { defineConfig, devices } from '@playwright/test'

// Playwright runs its own Vite (proxying /api to its own backend) on dedicated ports, so a dev server left
// running on 5173/8042 is never mistaken for the test stack. The backend (`python -m tests.e2e_server`) resets
// the `*_test` database and loads the synthetic explorer dataset. Overridable for parallel checkouts.
const WEB_PORT = process.env.VIPER_E2E_WEB_PORT ?? '5180'
const API_PORT = process.env.VIPER_E2E_API_PORT ?? '8180'
const BASE_URL = `http://localhost:${WEB_PORT}`
const API_URL = `http://127.0.0.1:${API_PORT}`

// Relative to backend/ (the API server's working directory); CI installs the requirements globally instead.
const VENV_PYTHON = process.platform === 'win32' ? join('.venv', 'Scripts', 'python.exe') : join('.venv', 'bin', 'python')
const PYTHON = process.env.VIPER_E2E_PYTHON ?? (existsSync(`../backend/${VENV_PYTHON}`) ? VENV_PYTHON : 'python')

export default defineConfig({
  testDir: './e2e',
  forbidOnly: Boolean(process.env.CI),
  reporter: 'list',
  use: { baseURL: BASE_URL, trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: `${PYTHON} -m tests.e2e_server --port ${API_PORT}`,
      cwd: '../backend',
      url: `${API_URL}/api/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
    {
      command: 'npm run dev',
      env: { VIPER_WEB_PORT: WEB_PORT, VIPER_API_TARGET: API_URL },
      url: BASE_URL,
      reuseExistingServer: !process.env.CI,
    },
  ],
})
