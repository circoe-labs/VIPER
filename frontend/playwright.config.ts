import { defineConfig, devices } from '@playwright/test'

import {
  BACKEND_DIR,
  E2E_API_PORT,
  E2E_BOOKING_URL,
  E2E_DATABASE_URL,
  E2E_OPENAI_PORT,
  E2E_TOOLBOX_PORT,
  E2E_TOOLBOX_STORE,
  E2E_WEB_PORT,
  PYTHON,
} from './e2e/env'

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
    // A local fake of the OpenAI Responses API: the AI drafting (S5) never reaches OpenAI (Contact port P6).
    {
      command: 'node e2e/fake-openai.ts',
      env: { VIPER_E2E_OPENAI_PORT: String(E2E_OPENAI_PORT) },
      url: `http://127.0.0.1:${String(E2E_OPENAI_PORT)}/health`,
      reuseExistingServer: !process.env.CI,
    },
    // A local fake of the CIRCOE Toolbox (OAuth + MCP mail tools): Infomaniak drafts never leave the machine (P6).
    {
      command: 'node e2e/fake-toolbox.ts',
      env: { VIPER_E2E_TOOLBOX_PORT: String(E2E_TOOLBOX_PORT) },
      url: `http://127.0.0.1:${String(E2E_TOOLBOX_PORT)}/health`,
      reuseExistingServer: !process.env.CI,
    },
    {
      command: `"${PYTHON}" -m uvicorn app.main:create_app --factory --host 127.0.0.1 --port ${String(E2E_API_PORT)}`,
      cwd: BACKEND_DIR,
      // The sender pre-filled in a new Contact message (synthetic, like every E2E value), and the AI drafting against
      // the fake OpenAI server with a fake key (every VIPER_OPENAI_* is set, so a backend/.env cannot leak in).
      env: {
        VIPER_DATABASE_URL: E2E_DATABASE_URL,
        VIPER_DEFAULT_OUTBOUND_EMAIL: 'prospection@exemple.example',
        VIPER_OPENAI_API_KEY: 'sk-e2e-fake-key',
        VIPER_OPENAI_MODEL: 'fake-e2e-model',
        VIPER_OPENAI_BASE_URL: `http://127.0.0.1:${String(E2E_OPENAI_PORT)}/v1`,
        VIPER_OPENAI_TIMEOUT_MS: '20000',
        VIPER_OPENAI_MAX_RETRIES: '1',
        VIPER_CONTACT_BOOKING_URL: E2E_BOOKING_URL,
        // The CIRCOE Toolbox (S6) against the fake: the browser comes back to the E2E Vite page; obsolete drafts are
        // deleted every second so a spec sees it happen.
        VIPER_TOOLBOX_MAIL_ENABLED: 'true',
        VIPER_TOOLBOX_MCP_URL: `http://127.0.0.1:${String(E2E_TOOLBOX_PORT)}/mcp`,
        VIPER_TOOLBOX_OAUTH_REDIRECT_URI: `${BASE_URL}/settings/connections`,
        VIPER_TOOLBOX_TOKEN_STORE_PATH: E2E_TOOLBOX_STORE,
        VIPER_TOOLBOX_TIMEOUT_MS: '10000',
        VIPER_TOOLBOX_CLEANUP_INTERVAL_MS: '1000',
      },
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
