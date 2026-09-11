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
python -m app.cli provision-sql-reader   # read-only role of the SQL console + its grants (again after each migration)
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
not end in `_e2e`), provisions the SQL console's reader role (`python -m app.cli provision-sql-reader`), loads the synthetic explorer dataset (`python -m tests.e2e_data`, same guard; written through
`audit.attributed_unit_of_work` with a system actor, so `audit_log` holds its creation events) and creates the
synthetic account `pilote.e2e@example.com` with `python -m app.cli create-user --password-stdin` and a random password
generated for the run. Every spec signs in through `signIn` (`frontend/e2e/session.ts`); `auth.spec.ts` drives the
real form. Tests run fully parallel with the default workers, in any order: each owns the data it writes (rules in
`testing-strategy.md`, decision I-81). Overrides: `VIPER_E2E_DATABASE_URL`, `VIPER_E2E_WEB_PORT`,
`VIPER_E2E_API_PORT`, `VIPER_E2E_PYTHON` (defaults: local `viper_e2e`, 5180, 8044, `backend/.venv` interpreter, else
`python` on PATH).

### Private workbook compatibility smoke (Task 08)

Only on a machine that has the private workbook (never in CI, never copied into the repository). From `backend/`:

```bash
VIPER_PRIVATE_WORKBOOK='C:\Projects\VIPER\tasks\viper_v1_implementation_handoff_reviewed\sources\BASE_CLIENT.xlsx' \
  python -m pytest tests/test_import_private_workbook.py -m private -s -p no:cacheprovider
```

It prints counts per diagnostic code only and asserts the known structure; without the variable it is skipped.
Import bounds are settings: `VIPER_IMPORT_MAX_FILE_MB` (10), `VIPER_IMPORT_MAX_ROWS` (5000), `VIPER_IMPORT_MAX_COLUMNS`
(100).

### Prospection (Task 14)

`/prospection` reads `GET /api/prospection/counters` and `/prospects` (definitions: `doc/features/prospection-kpis.md`).
To see it with data, load the synthetic explorer dataset into an `_e2e` database (above) or import a synthetic
workbook (below). `VIPER_VERIFICATION_STALE_DAYS=<days>` (unset by default, open question #9) makes verifications older
than that count as « À revérifier ».

### Home (Task 16)

`/` reads `GET /api/home` (definitions: `doc/features/home-dashboard.md`). With an empty database it invites to import;
load the synthetic dataset or import a synthetic workbook to see figures. The informative monthly targets are settings:
`VIPER_MONTHLY_CONTACT_TARGET` (100) and `VIPER_MONTHLY_APPOINTMENT_TARGET` (10). Monthly figures come from the
contact-tracking status history, so stages imported from a workbook never count as this month's contacts.

### Global search (Task 17)

The header field (Ctrl+K or `/`) reads `GET /api/search?q=` (behaviour: `doc/features/global-search.md`). Load the
synthetic dataset or import a synthetic workbook to try it. `tests/test_search_performance.py` builds 20 000 synthetic
prospects inside the test transaction and requires p95 < 150 ms; with `CI` set it uses 2 000 prospects and 500 ms.
The same seed helps manual measurements on a throwaway `_e2e` or worktree database (`seed_base(session, 20_000)`, then
`VACUUM ANALYZE`) — never on a database you keep.

### Excel import review and commit (Task 09)

The page is `/prospection/import` (« Importer Excel » in the Prospection and Entreprises headers). For a
manual check use a **synthetic** workbook, e.g. generated from the test fixtures (from `backend/`, written outside the
repository):

```bash
python -c "from tests.fixtures.synthetic.legacy_workbook import SAMPLE_ROWS, legacy_xlsx; open('/tmp/base_synthetique.xlsx','wb').write(legacy_xlsx(SAMPLE_ROWS))"
```

Uploads go through `python-multipart` (in `requirements.txt`). The private end-to-end check (preview **and commit** of
the real workbook with the default decisions, rows without any name excluded) runs inside the test database's
rolled-back transaction, so no real row survives it; it prints aggregate counts and invariant checks only:

```bash
VIPER_PRIVATE_WORKBOOK='C:\Projects\VIPER\tasks\viper_v1_implementation_handoff_reviewed\sources\BASE_CLIENT.xlsx' \
  python -m pytest tests/test_import_private_commit.py -m private -s -p no:cacheprovider
```

Never commit the real workbook into the dev database you keep: if you do it by hand for a check, reset that database
afterwards (`alembic downgrade base`).

### Excel export (Task 10)

« Exporter Excel » (Entreprises and Import headers) downloads `GET /api/exports/workbook` — the whole database of
the backend you run. For a manual look at the layout, import a synthetic workbook (section above) and export. A
private check against the real workbook must follow the Task 09 rule: import it only into a throwaway worktree
database, build the export in memory, print aggregate counts only (rows per sheet, non-empty `Référent` cells, legacy
entries vs stored row metadata, formula cells), never save the exported file inside a repository, then reset that
database (`alembic downgrade base` + `alembic upgrade head`).

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

After a migration, re-run `python -m app.cli provision-sql-reader`: the SQL console's read-only role
(`viper_sql_reader`, ADR-0011) holds column grants on the exposed tables, which new columns or tables do not inherit.
Without it the console answers « Table non accessible » for them (or « Console SQL indisponible » if the role does not
exist yet); it never exposes more. The command needs CREATEROLE to create the role (the local `viper` user has it);
otherwise it prints the SQL for an administrator.

After `--autogenerate`, review the file, then `ruff format migrations`. Every new model module must be imported in
`app/models/__init__.py` (the migration test fails if models and migrations drift). Conventions:
[ADR-0002](../adr/0002-data-schema-conventions.md) — in particular, write enum value lists as literals (never import
app code into a migration), add the `set_updated_at` trigger to any new table with `updated_at`, and index every FK;
`tests/test_migrations.py` checks all three because autogenerate ignores CHECKs and triggers.
Migration `0005` creates the `unaccent` extension (shipped with the `postgres:16-alpine` image; any hosting database
must allow it) and the `label_key` function used by the Settings uniqueness indexes ([ADR-0009](../adr/0009-settings-value-uniqueness.md)).
Migration `0007` creates the `pg_trgm` extension (same image, *trusted* since PostgreSQL 13; any hosting database must
allow it too), the `search_key` / `person_search_key` functions and the global search's trigram indexes
([ADR-0017](../adr/0017-global-search-trigram-indexes.md)).

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
