import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

// Full-stack E2E settings, shared by playwright.config.ts, the E2E Vite config, global setup and the specs.
// Dedicated ports: a run never reuses the dev servers (Vite 5173 → backend 8042 → dev database). Every value is
// overridable, so a second checkout (git worktree) can run its own stack on other ports and another `*_e2e` DB.
export const E2E_WEB_PORT = Number(process.env.VIPER_E2E_WEB_PORT ?? 5180)
export const E2E_API_PORT = Number(process.env.VIPER_E2E_API_PORT ?? 8044)
// The fake OpenAI server (e2e/fake-openai.ts): the E2E backend drafts against it, never against OpenAI (P6).
export const E2E_OPENAI_PORT = Number(process.env.VIPER_E2E_OPENAI_PORT ?? 8046)
// The fake CIRCOE Toolbox (e2e/fake-toolbox.ts): the E2E backend connects to it, never to the Toolbox (P6). Its OAuth
// token file lives in the system temp folder (outside the checkout, as the backend requires), one per API port.
export const E2E_TOOLBOX_PORT = Number(process.env.VIPER_E2E_TOOLBOX_PORT ?? 8047)
export const E2E_TOOLBOX_STORE = path.join(tmpdir(), `viper-e2e-toolbox-${String(E2E_API_PORT)}.json`)
export const E2E_BOOKING_URL = 'https://rdv.exemple.example/circoe'
export const E2E_DATABASE_URL =
  process.env.VIPER_E2E_DATABASE_URL ?? 'postgresql+psycopg://viper:viper@127.0.0.1:5442/viper_e2e'

export const BACKEND_DIR = path.resolve(import.meta.dirname, '../../backend')
const VENV_PYTHON = path.join(BACKEND_DIR, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
// Backend interpreter: VIPER_E2E_PYTHON, else the local venv, else `python` on PATH (CI).
export const PYTHON = process.env.VIPER_E2E_PYTHON ?? (existsSync(VENV_PYTHON) ? VENV_PYTHON : 'python')

// Synthetic account created by global setup; its password is random per run (never committed).
export const E2E_USER = { email: 'pilote.e2e@example.com', displayName: 'Pilote E2E' }
export const PASSWORD_ENV = 'VIPER_E2E_PASSWORD'

export function e2ePassword(): string {
  const password = process.env[PASSWORD_ENV]
  if (!password) throw new Error(`${PASSWORD_ENV} is not set: run the specs through playwright.config.ts (global setup)`)
  return password
}
