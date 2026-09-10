# Runbook — local development

From a fresh clone to a running app and green tests. Commands are for **PowerShell** (Windows dev machine); Git Bash
differences are noted. Stack and versions: `doc/adr/0001-stack.md`.

## Prerequisites

- Docker Desktop, Python 3.14 (`python --version`), Node 24 + npm (`node --version`), Git.
- Free local ports: **5442** (PostgreSQL), **8042** (backend), **5173** (Vite). Ports 5432/8000 belong to other
  projects — never stop their containers.

## 1. Database (PostgreSQL 16 in Docker)

```powershell
docker compose up -d --wait        # from the repo root; starts only the `viper` project's `db` service
docker compose ps                  # viper-db-1 … (healthy)  127.0.0.1:5442->5432/tcp
```

Creates databases `viper` (dev) and `viper_test` (tests) on the **first** start of the `viper_pgdata` volume. If the
volume predates the init script and `viper_test` is missing:
`docker compose exec db psql -U viper -d viper -c "CREATE DATABASE viper_test OWNER viper"`.

## 2. Backend (`backend/`)

```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1        # Git Bash: source .venv/Scripts/activate
pip install -r requirements-dev.txt
alembic upgrade head               # migrate the dev database
uvicorn app.main:create_app --factory --reload --port 8042
```

Configuration comes from `VIPER_*` environment variables or an optional `backend/.env` (copy `.env.example`;
`.env` is git-ignored — never commit it). Defaults already match `docker-compose.yml`. Run backend commands from
`backend/` so `.env` and `alembic.ini` are found.

Health: <http://127.0.0.1:8042/api/health> → `{"status":"ok","database":"ok"}` (HTTP 503 with
`"database":"unavailable"` when PostgreSQL is down). OpenAPI docs: <http://127.0.0.1:8042/api/docs>.

## 3. Frontend (`frontend/`)

```powershell
cd frontend
npm ci                             # or `npm install` when changing dependencies
npm run dev                        # http://localhost:5173 ; /api is proxied to 127.0.0.1:8042
```

The left navigation shows `API : connectée` when the backend and database answer. With the dev server running,
<http://localhost:5173/_dev/ui> shows the design-system component showcase (not part of production builds).

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
| `frontend/` | `npx playwright install chromium` once, then `npm run e2e` | Playwright smoke + design checks; starts Vite itself (reuses a running one locally); writes review screenshots of both themes to `frontend/test-results/screenshots/` (git-ignored) |
| `frontend/` | `npm run brand:assets` | regenerate the web-sized logos and favicons from the handoff originals (only when a logo changes; see `doc/design/visual-manifest.md`) |

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
`app/models/__init__.py` (the migration test fails if models and migrations drift). Full wipe of local data:
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

- `Port 5173 is already in use` — Vite uses `strictPort`; stop the other dev server rather than drifting to 5174
  (the Playwright config and proxy assume 5173).
- `Refusing to run tests against database …` — `VIPER_TEST_DATABASE_URL` must name a database ending in `_test`.
- Health returns 503 after ~5 s — PostgreSQL is not reachable on 5442 (`docker compose ps`).
