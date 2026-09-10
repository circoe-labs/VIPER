# ADR-0001 — Application stack, layout and tooling

- Status: accepted
- Date: 2026-09-10
- Deciders: orchestrator (decision I-01), implemented by Task 01
- Related: `doc/product/decision-log.md` (I-01, I-06), `doc/architecture/overview.md`,
  `doc/process/runbook-local-dev.md`
- Amended: 2026-09-10 by decision I-17 — services no longer call `session.commit()`; they flush and the caller's
  unit of work (`SessionDep` per request, `unit_of_work` for CLI/jobs) owns the transaction
  (`doc/architecture/overview.md`, *Transaction boundaries*).
- Amended: 2026-09-10 by Task 04 (decision I-25, [ADR-0004](0004-authentication-sessions.md)) — Playwright runs full
  stack (real backend on the `viper_e2e` database, ports 8044/5180), locally and in CI; the CI `e2e` job has a
  PostgreSQL service. Dependency added: `argon2-cffi` 25.1.0.

## Context

The handoff left the stack open ("prefer existing Circoe conventions; otherwise a boring typed stack with strong
migrations/testability"). Two Circoe projects exist on the development machine and share the same backbone:
IGuard (FastAPI + SQLAlchemy 2 + Alembic + PostgreSQL, React + TypeScript + Vite, pytest/Vitest/Playwright) and
Onduline (FastAPI + pydantic-settings + SQLAlchemy 2 + Alembic + PostgreSQL 16, ruff + strict mypy).

VIPER needs: a relational, transactional store with real FK/unique constraints and versioned migrations; a
database-enforced read-only path for the SQL console (Task 13); strict typing on both sides; tests against a real
database; and a Windows development machine (PowerShell 5.1, Git Bash, no `make`). The repository is public.

## Decision

### Backend — `backend/`

| Concern | Choice (pinned in `backend/requirements*.txt`) |
|---|---|
| Runtime | Python **3.14** (3.14.6 locally, `3.14` in CI) — every dependency ships cp314 wheels; no `uv` needed |
| HTTP | FastAPI 0.141.1, served by uvicorn[standard] 0.52.4 |
| ORM | SQLAlchemy 2.0.52, typed declarative models (`Mapped[...]`), sync sessions |
| Migrations | Alembic 1.19.2 (`backend/migrations/`, sequential revision ids `0001`, `0002`, …) |
| Driver | psycopg 3.3.5 (`psycopg[binary]`), URL scheme `postgresql+psycopg://` |
| Config | pydantic 2.13.5 + pydantic-settings 2.15.0; env prefix `VIPER_`, optional `backend/.env` |
| Tests | pytest 9.1.1; FastAPI `TestClient` backed by **httpx2** 2.12.0 (Starlette 1.6 deprecates `httpx` for its test client) |
| Quality | ruff 0.16.6 (lint + format, line length 100), mypy 2.3.1 `strict = true` + pydantic plugin |

Package layout (dependencies point downward only):

```
app/main.py            create_app(settings) factory; engine per app instance, disposed on shutdown
app/api/               thin FastAPI routers (routes/), shared dependencies (SessionDep)
app/services/          business rules + transaction boundaries (services call session.commit())
app/repositories/      the only place building ORM/SQL queries for domain entities
app/models/            ORM models (Task 03+), all imported by app/models/__init__.py
app/db/                declarative Base (with constraint naming convention), engine/session factories
app/core/              typed Settings
migrations/            Alembic env + versions
```

One SQLAlchemy session per request, injected with `SessionDep`. The UI never talks to the database: UI → HTTP
`/api/*` → services → repositories/ORM → PostgreSQL.

### Frontend — `frontend/`

| Concern | Choice (exact versions in `frontend/package.json`, lockfile committed) |
|---|---|
| Runtime | Node 24 (24.18.0 locally), npm 12 |
| UI | React 19.3.0, React Router 8.3.1 (data router), TanStack Query 5.102.8 |
| Build | Vite 8.2.2 + `@vitejs/plugin-react` 6.1.1 |
| Language | TypeScript **6.0.3**, `strict` + `noUncheckedIndexedAccess`, `verbatimModuleSyntax`, `erasableSyntaxOnly` |
| Lint | ESLint 10.10 flat config, `typescript-eslint` 8.70 `strictTypeChecked`, `eslint-plugin-react-hooks` 7.1 |
| Unit/component tests | Vitest 4.1.11 + jsdom 29.1.1 + Testing Library (react 16.3, jest-dom 7.0, user-event 14.6) |
| E2E | Playwright 1.63.0 (Chromium) |
| Styling | Hand-written CSS; no UI kit, no Tailwind. Design tokens arrive in Task 02 |

A thin typed client (`src/api/client.ts`, `apiGet<T>`) is the only code that calls `fetch`; feature hooks wrap it
with TanStack Query (e.g. `useHealth`). Routes (English URL segments, French labels): `/` Accueil, `/prospection`,
`/exploitation`, `/database` Base de données, `/settings` Paramètres; unknown paths redirect to `/`.

### Database and ports

- PostgreSQL **16** (`postgres:16-alpine`) via root `docker-compose.yml`, project name `viper`, bound to
  `127.0.0.1:5442`. Databases `viper` (dev) and `viper_test` (tests; created by `docker/postgres/init/`).
  Credentials `viper`/`viper` are local-development defaults, not secrets.
- Backend dev server: **8042**. Vite dev server: **5173** (`strictPort`), proxying `/api` → `127.0.0.1:8042`.
  Ports 8000 and 5432 are taken by other local projects.
- OpenAPI docs at `/api/docs` (behind the same proxy).

### Tests

- pytest runs against the real `viper_test` database. The session fixture refuses any database whose name does
  not end in `_test`, drops/recreates the `public` schema and runs `alembic upgrade head`. Each test gets a session
  bound to an outer transaction with `join_transaction_mode="create_savepoint"`, rolled back at teardown — so even
  `commit()` in services is isolated.
- A migration test round-trips `downgrade base` / `upgrade head` and asserts that the migrated schema matches the
  ORM metadata (`compare_metadata` returns no diff), so models and migrations cannot drift.

### Tooling and CI

- No `make`: backend commands are plain `ruff`/`mypy`/`pytest`/`alembic` run from `backend/`; frontend commands are
  `npm run …` scripts; `python scripts/verify.py [--e2e]` runs every gate in CI order (PowerShell and Bash alike).
- `.github/workflows/ci.yml`: privacy guard; backend (Postgres 16 service on 5442, ruff, format check, mypy,
  migration CLI smoke, pytest); frontend (eslint, tsc, vitest, build); e2e (Playwright Chromium shell smoke, no
  backend). The workflow uploads **no** artifacts.
- `scripts/check_private_data.py` fails when git tracks or stages anything under `tasks/**/sources/`, any
  `BASE_CLIENT*` file, or any spreadsheet/CSV outside `backend|frontend/tests/fixtures/synthetic/`.

## Consequences

- Same backbone as IGuard/Onduline: shared know-how, similar reviews, Alembic autogenerate from typed models.
- PostgreSQL gives real constraints, partial unique indexes (one active primary email/phone), JSONB for
  `legacy_metadata`, and a read-only role/`default_transaction_read_only` for the SQL console (Task 13).
- Tests need Docker (or any PostgreSQL 16 reachable through `VIPER_TEST_DATABASE_URL`); no SQLite shortcut, so
  behaviour under test equals production behaviour.
- Sync SQLAlchemy is enough for a single-user pilot; FastAPI runs sync routes in its threadpool.
- Python 3.14 and very recent frontend majors are used; if a future dependency lacks cp314 wheels, pin CI and local
  to 3.13 through a new ADR rather than silently diverging.
- The frontend `Health` type mirrors the backend schema by hand; generating types from `/api/openapi.json` can be
  introduced when the API grows (new ADR if a generator is added).
- Playwright in CI covers the shell only; a full-stack E2E (backend + DB + auth) belongs to Task 04/20.

## Alternatives considered

- **Node/TypeScript full-stack (e.g. NestJS/Express + Prisma/Drizzle)** — one language, but diverges from Circoe
  conventions and loses the existing Python/SQLAlchemy/Alembic experience; Excel parsing (Task 08) is also well
  served by `openpyxl`.
- **SQLite** — simpler setup, but weaker constraint/typing semantics, no database roles for the read-only SQL
  console, and a SQLite test shortcut would hide Postgres-only behaviour (constraints, JSONB, roles).
- **Async SQLAlchemy** — unnecessary for a single-user pilot and harder to test; can be revisited per ADR.
- **UI kit / Tailwind** — rejected by the orchestrator: Task 02 implements the Neon Command tokens by hand.
- **TypeScript 7 / Vitest 5** — available but `typescript-eslint` 8.70 supports TypeScript `< 6.1`, and Vitest
  5.0.0 was one week old; revisit on the next dependency refresh.
- **`uv` / alternate Python via `py` launcher** — not needed: all wheels exist for the installed Python 3.14.
