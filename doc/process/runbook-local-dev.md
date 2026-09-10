# Runbook — local development

From a fresh clone to a running app and green tests. Commands are for **PowerShell** (Windows dev machine); Git Bash
differences are noted. Stack and versions: `doc/adr/0001-stack.md`.

## Prerequisites

- Docker Desktop, Python 3.14 (`python --version`), Node 24 + npm (`node --version`), Git.
- Free local ports: **5442** (PostgreSQL), **8042** (backend), **5173** (Vite); **8044** and **5180** during
  Playwright runs (E2E backend and Vite). Ports 5432/8000 belong to other projects — never stop their containers.

## 1. Database (PostgreSQL 16 in Docker)

```powershell
docker compose up -d --wait        # from the repo root; starts only the `viper` project's `db` service
docker compose ps                  # viper-db-1 … (healthy)  127.0.0.1:5442->5432/tcp
```

Creates databases `viper` (dev), `viper_test` (pytest) and `viper_e2e` (Playwright) on the **first** start of the
`viper_pgdata` volume. If the volume predates an init script, create the missing ones:
`docker compose exec db psql -U viper -d viper -c "CREATE DATABASE viper_test OWNER viper"` (same with `viper_e2e`).

## 2. Backend (`backend/`)

```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1        # Git Bash: source .venv/Scripts/activate
pip install -r requirements-dev.txt
alembic upgrade head               # migrate the dev database
python -m app.seed                 # suggested roles/segments/categories (idempotent, optional)
python -m app.cli create-user --email vous@example.com --display-name "Prénom Nom"   # prompts for the password
uvicorn app.main:create_app --factory --reload --port 8042
```

### Login account

The app requires signing in; there is **no default account or password**. `python -m app.cli create-user` creates
the account in the database named by `VIPER_DATABASE_URL` and prompts twice for the password (12–1024 characters).
Run it again with the same `--email` to reset a forgotten password — this also signs out every open session
(`--display-name` is then optional). For scripts, `--password-stdin` reads the password from the first line of stdin;
never pass a password as an argument or commit it. Sessions last 120 min without activity and 12 h at most
(`VIPER_SESSION_IDLE_TIMEOUT_MINUTES` / `VIPER_SESSION_ABSOLUTE_TIMEOUT_HOURS`). The session cookie is `Secure` by
default, which browsers accept on `http://localhost`; only if you reach the dev server over plain HTTP through another
host name, set `VIPER_SESSION_COOKIE_SECURE=false` in `backend/.env`. Design: [ADR-0004](../adr/0004-authentication-sessions.md).

Configuration comes from `VIPER_*` environment variables or an optional `backend/.env` (copy `.env.example`;
`.env` is git-ignored — never commit it). Defaults already match `docker-compose.yml`. Run backend commands from
`backend/` so `.env` and `alembic.ini` are found.

Health: <http://127.0.0.1:8042/api/health> → `{"status":"ok","database":"ok"}` (HTTP 503 with
`"database":"unavailable"` when PostgreSQL is down). OpenAPI docs: <http://127.0.0.1:8042/api/docs>. Every other
`/api/*` route answers 401 without a session (sign in through the UI, or `POST /api/auth/login`).

## 3. Frontend (`frontend/`)

```powershell
cd frontend
npm ci                             # or `npm install` when changing dependencies
npm run dev                        # http://localhost:5173 ; /api is proxied to 127.0.0.1:8042
```

Open <http://localhost:5173>: you land on the sign-in page (`Connexion`) and, once signed in, on the page you asked
for. The header shows your name and `Se déconnecter`; the left navigation shows `API : connectée` when the backend
and database answer. With the dev server running, <http://localhost:5173/_dev/ui> shows the design-system component
showcase (not part of production builds; sign in first).

### Ports and parallel checkouts

Every port is overridable, so a second checkout (e.g. a `git worktree`) can run beside the first one:

| Variable | Default | Used by |
|---|---|---|
| `VIPER_WEB_PORT` | `5173` | `npm run dev` (Vite, `strictPort`) |
| `VIPER_API_TARGET` | `http://127.0.0.1:8042` | Vite's `/api` proxy target |
| `VIPER_E2E_WEB_PORT` / `VIPER_E2E_API_PORT` | `5180` / `8044` | Playwright's own Vite and API |
| `VIPER_E2E_DATABASE_URL` | `…/viper_e2e` | Playwright's database (name must end in `_e2e`) |
| `VIPER_E2E_PYTHON` | `backend/.venv` Python, else `python` | interpreter for the Playwright API server and setup |

Worktree example (Git Bash): `backend/.env` with its own `VIPER_DATABASE_URL=…/viper_wt` and
`VIPER_TEST_DATABASE_URL=…/viper_wt_test`, an own E2E database (`CREATE DATABASE viper_wt_e2e OWNER viper`), then
`uvicorn … --port 8043`, `VIPER_WEB_PORT=5174 VIPER_API_TARGET=http://127.0.0.1:8043 npm run dev`, and
`VIPER_E2E_DATABASE_URL=…/viper_wt_e2e VIPER_E2E_WEB_PORT=5174 VIPER_E2E_API_PORT=8043 python scripts/verify.py --e2e`
(with those dev servers stopped).

### Synthetic data for manual checks

The synthetic explorer dataset (`backend/tests/fixtures/synthetic/explorer_dataset.py`: 36 companies, 240
prospects, emails, phones, tracking, an import batch, audit entries — all invented) can be loaded into any empty,
migrated `*_e2e` database — never the dev database — from `backend/`:

```bash
export VIPER_DATABASE_URL=postgresql+psycopg://viper:viper@127.0.0.1:5442/viper_e2e
alembic downgrade base && alembic upgrade head
python -m tests.e2e_data                      # refuses a database whose name does not end in _e2e
python -m app.cli create-user --email pilote.local@example.com --display-name "Pilote Local"
uvicorn app.main:create_app --factory --port 8044
```

then point a Vite at it (`VIPER_API_TARGET=http://127.0.0.1:8044`). A Playwright run rebuilds that database again.

## 4. Quality gates

All gates, CI order (needs the venv, `npm ci` and the database up):

```powershell
python scripts/verify.py           # add --e2e to include Playwright
```

Individually:

| Where | Command | What |
|---|---|---|
| root | `python scripts/check_private_data.py` | privacy guard (see below) |
| `backend/` | `ruff check . ../scripts` · `ruff format --check . ../scripts` | lint · format (`ruff format . ../scripts` to fix) |
| `backend/` | `mypy` | strict typecheck of `app`, `migrations`, `tests`, `../scripts` |
| `backend/` | `pytest` | tests against `viper_test` (schema reset + migrations at session start) |
| `frontend/` | `npm run lint` · `npm run typecheck` | ESLint (type-aware) · `tsc -b` |
| `frontend/` | `npm test` (`npm run test:watch`) | Vitest component/unit tests |
| `frontend/` | `npm run build` | typecheck + production bundle in `frontend/dist/` |
| `frontend/` | `npx playwright install chromium` once, then `npm run e2e` | Full-stack Playwright (auth flows, shell, design checks, Database explorer reads and staged editing): see *End-to-end tests* below; writes review screenshots of both themes to `frontend/test-results/screenshots/` (git-ignored) |
| `frontend/` | `npm run brand:assets` | regenerate the web-sized logos and favicons from the handoff originals (only when a logo changes; see `doc/design/visual-manifest.md`) |

### End-to-end tests

`npm run e2e` (or `python scripts/verify.py --e2e`) needs the Docker database and the backend venv, nothing else
running. Playwright starts its own backend (`uvicorn` on **8044**, database **`viper_e2e`**) and Vite (**5180**,
proxying `/api` to 8044) — it never touches the dev servers or the dev database — and stops them at the end (locally
it reuses servers already listening on those ports). Global setup (`frontend/e2e/global-setup.ts`) rebuilds
`viper_e2e` through the migrations (`alembic downgrade base` + `upgrade head`; it refuses a database whose name does
not end in `_e2e`), loads the synthetic explorer dataset (`python -m tests.e2e_data`, same guard; written through
`audit.attributed_unit_of_work` with a system actor, so `audit_log` holds its creation events) and creates the
synthetic account `pilote.e2e@example.com` with `python -m app.cli create-user --password-stdin` and a random password
generated for the run. Every spec signs in through `signIn` (`frontend/e2e/session.ts`); `auth.spec.ts` drives the
real form. Overrides: `VIPER_E2E_DATABASE_URL`, `VIPER_E2E_WEB_PORT`, `VIPER_E2E_API_PORT`, `VIPER_E2E_PYTHON`
(defaults: local `viper_e2e`, 5180, 8044, `backend/.venv` interpreter, else `python` on PATH).

## 5. Migrations

Run from `backend/` with the venv active. `-x db=test` targets `VIPER_TEST_DATABASE_URL` instead of the dev DB.

```powershell
alembic upgrade head                              # apply all migrations (dev DB)
alembic downgrade -1                              # undo the last one
alembic current ; alembic history                 # inspect
alembic downgrade base ; alembic upgrade head     # reset the dev schema through migrations
alembic -x db=test upgrade head                   # same commands on viper_test
alembic revision --autogenerate --rev-id 0002 -m "short description"   # new revision from ORM models
```

After `--autogenerate`, review the file, then `ruff format migrations`. Every new model module must be imported in
`app/models/__init__.py` (the migration test fails if models and migrations drift). Conventions:
[ADR-0002](../adr/0002-data-schema-conventions.md) — in particular, write enum value lists as literals (never import
app code into a migration), add the `set_updated_at` trigger to any new table with `updated_at`, and index every FK;
`tests/test_migrations.py` checks all three because autogenerate ignores CHECKs and triggers.

Seed data is separate from migrations: `python -m app.seed` (dev) or `python -m app.seed --db test` inserts the
suggested taxonomy values that are missing and never modifies existing rows, so it is safe to re-run. Full wipe of
local data:
`docker compose down -v` then `docker compose up -d --wait` (destroys the `viper_pgdata` volume — VIPER only).

## 6. Stopping

`Ctrl+C` in the uvicorn and Vite terminals; `docker compose stop` (keeps data) or `docker compose down` (keeps the
volume) from the repo root.

## Privacy guard

The GitHub repository is **public**. `tasks/**/sources/` (real client workbook) and every spreadsheet/CSV are
git-ignored; `scripts/check_private_data.py` fails if any of them is tracked or staged anyway (`git ls-files`),
printing paths only. Only synthetic fixtures under `backend/tests/fixtures/synthetic/` or
`frontend/tests/fixtures/synthetic/` may be committed. Run it (or `scripts/verify.py`) before every commit and check
`git status`. CI runs it on every push/PR and never uploads artifacts.

## Troubleshooting

- `Port 5173 is already in use` — Vite uses `strictPort`; stop the other dev server, or give this checkout its own
  ports (`VIPER_WEB_PORT`, see *Ports and parallel checkouts*). Playwright uses 5180 and 8044 the same way
  (`VIPER_E2E_WEB_PORT` / `VIPER_E2E_API_PORT`).
- Sign-in says `Adresse e-mail ou mot de passe incorrect.` — no account yet in this database, or a wrong password:
  (re)run `python -m app.cli create-user --email …`. `Trop de tentatives…` — 5 failures for one e-mail (20 in total)
  within 15 min from your address; wait, or restart the backend (the counter is in memory).
- Playwright global setup fails with `database "viper_e2e" does not exist` — create it (section 1).
- `Refusing to run tests against database …` — `VIPER_TEST_DATABASE_URL` must name a database ending in `_test`.
- Health returns 503 after ~5 s — PostgreSQL is not reachable on 5442 (`docker compose ps`).
