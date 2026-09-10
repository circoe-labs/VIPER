import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'

import { BACKEND_DIR, E2E_DATABASE_URL, E2E_USER, PASSWORD_ENV, PYTHON } from './env'

// Once per run: rebuild the dedicated E2E database through the migrations, provision the SQL console's reader role,
// load the synthetic explorer dataset (backend/tests/fixtures/synthetic/), then create the pilot account with the
// real bootstrap CLI and a random password that reaches the specs through the environment (workers inherit it).
export default function globalSetup() {
  const database = new URL(E2E_DATABASE_URL.replace(/^[\w+]+:/, 'postgres:')).pathname.slice(1)
  if (!database.endsWith('_e2e')) {
    throw new Error(`Refusing to reset database "${database}": its name must end with "_e2e".`)
  }
  const run = (args: string[], input?: string) =>
    execFileSync(PYTHON, args, {
      cwd: BACKEND_DIR,
      env: { ...process.env, VIPER_DATABASE_URL: E2E_DATABASE_URL },
      input,
      stdio: [input === undefined ? 'ignore' : 'pipe', 'inherit', 'inherit'],
    })

  run(['-m', 'alembic', 'downgrade', 'base'])
  run(['-m', 'alembic', 'upgrade', 'head'])
  // Read-only role of the SQL console and its grants on the freshly migrated tables (ADR-0011).
  run(['-m', 'app.cli', 'provision-sql-reader'])
  run(['-m', 'tests.e2e_data'])
  const password = randomBytes(24).toString('base64url')
  const createUser = ['--email', E2E_USER.email, '--display-name', E2E_USER.displayName, '--password-stdin']
  run(['-m', 'app.cli', 'create-user', ...createUser], `${password}\n`)
  process.env[PASSWORD_ENV] = password
}
