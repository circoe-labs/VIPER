# Task 01 — Choose stack and scaffold the application

## Goal
Create the minimal production-capable typed web foundation, relational persistence scaffold, tests and CI baseline.

## Context
No stack was locked. Prefer existing Circoe conventions if they now exist; otherwise choose a boring typed stack with strong migrations/testability.

## Coding Skill Requirement
Before editing code, load and follow `/caveman` and `/coding-guideline` from `~/ai/skills/`.

## Scope
### In Scope
- Frontend/backend/data boundary.
- Package/tooling, lint/typecheck/tests.
- Relational DB connectivity + migration command.
- Route shell placeholders without fake business data.
- CI baseline.
- `.gitignore`/local-dev conventions protecting private source workbook.

### Out of Scope
- No feature UI/data model beyond migration smoke.
- No agents/mail/Calendly.

## Dependencies
Task 00.

## Implementation Steps
1. Inspect repo conventions.
2. Document stack ADR.
3. Scaffold app/server/data boundaries.
4. Configure DB/migrations.
5. Configure lint/typecheck/test/build.
6. Configure CI without uploading private files.
7. Add local environment instructions.

## Files Likely Touched
Root project files, app/server source skeleton, DB config, CI, README, ignore rules.

## Architecture Constraints
UI components do not access SQL/ORM directly. Typed config. No secrets or real client data committed.

## Testing Requirements
Fresh install, build, lint, typecheck, unit smoke, app boot, migration smoke, git check that private workbook is excluded.

## Acceptance Criteria
- Fresh clone boots.
- CI baseline green.
- Stack decision documented.
- Private source handling is explicit.

## Documentation Updates
Update repo README + ADR.

## Handoff Notes
Global visual styling comes in Task 02.

## Implementation report

Date: 2026-09-10 · Branch `claude` · Stack decision I-01 documented in `doc/adr/0001-stack.md`.

### Done
- **Backend skeleton** (`backend/`): `create_app(settings)` factory (engine per app, disposed on shutdown), typed
  `Settings` (pydantic-settings, `VIPER_*` env, optional `backend/.env`, only `.env.example` committed),
  SQLAlchemy 2 engine/session factories, declarative `Base` with a constraint naming convention, request-scoped
  `SessionDep`, `GET /api/health` (200 `{"status":"ok","database":"ok"}` / 503 `{"status":"degraded","database":"unavailable"}`,
  5 s connect timeout, logs exception class only), OpenAPI under `/api/docs`. Layered packages `api/ services/
  repositories/ models/ db/ core/` with one-line boundary docstrings; no business tables.
- **Alembic** (`backend/migrations/`): env reads the URL from settings (`-x db=test` targets the test DB, tests pass
  it programmatically); empty baseline revision `0001`; sequential `--rev-id` convention.
- **PostgreSQL 16** via root `docker-compose.yml` (project `viper`, `127.0.0.1:5442`, volume `viper_pgdata`), init
  script creates `viper_test`.
- **Backend tests**: fixtures refuse non-`*_test` databases, reset the `public` schema, migrate to head, and give
  each test a session in an outer transaction rolled back at teardown (`create_savepoint`); tests for health
  (ok + unreachable DB), OpenAPI prefix, settings env prefix, transaction isolation, migration single head /
  round-trip / models-vs-migrations drift, privacy guard rules + current repo state.
- **Frontend shell** (`frontend/`): React 19 + TS strict + Vite 8, React Router 8 data router, TanStack Query,
  typed `apiGet<T>` client + `useHealth`; left navigation with `Accueil`, `Prospection`, `Exploitation`,
  `Base de données`, `Paramètres` (routes `/`, `/prospection`, `/exploitation`, `/database`, `/settings`, unknown →
  `/`), bare `<h1>` placeholders, `API : connectée / indisponible / vérification…` status. Structural CSS only.
- **Frontend tests**: Vitest + Testing Library (client success/error, nav order, current route, navigation,
  redirect, API status ok/failed); Playwright smoke `e2e/shell.spec.ts`.
- **Scripts/CI**: `scripts/check_private_data.py` (privacy guard), `scripts/verify.py [--e2e]` (all gates, shell
  agnostic), `.github/workflows/ci.yml` (privacy-guard, backend with Postgres service, frontend, e2e; no artifact
  uploads). `.gitignore` spreadsheet list extended (`*.xlsb`, `*.ods`, `*.tsv`) to match the guard.
- **Docs**: ADR-0001, `doc/process/runbook-local-dev.md`, root `README.md`, decision log (deferred stack bullet →
  ADR-0001; new I-08 for route paths/ports), `architecture/overview.md`, `features/interface-spec.md`,
  `process/testing-strategy.md`, `process/agent-brief.md` pointers.

### Verification (local, Windows 11, Python 3.14.6, Node 24.18.0, Docker PostgreSQL 16.14)
- `docker compose up -d --wait` (VIPER `db` only) → healthy; `viper` and `viper_test` present.
- Fresh `python -m venv` + `pip install -r requirements-dev.txt` → `pip check` clean; fresh `npm ci` → 250 packages.
- `alembic upgrade head / downgrade base / upgrade head` on dev and `-x db=test` on test DB → `0001 (head)`.
- `python scripts/verify.py --e2e` → privacy guard OK; ruff check + format OK (28 files); mypy strict OK
  (28 files); **pytest 20 passed**; eslint OK; `tsc -b` OK; **vitest 8 passed**; vite build OK; **Playwright 1 passed**.
- Both servers booted (uvicorn 8042, Vite 5173): `/api/health` → 200 directly and through the Vite proxy; with the
  VIPER DB container stopped → 503 `unavailable` after ~5 s, back to 200 after restart. Servers stopped afterwards.
- Privacy guard failure path checked in a scratch git repo (staged CSV + `tasks/*/sources/*` → exit 1).

### Deviations / decisions
- Test client uses **httpx2** 2.12.0 instead of `httpx` (Starlette 1.6 deprecates `httpx` for `TestClient`).
- TypeScript **6.0.3** (not 7) because `typescript-eslint` 8.70 requires `< 6.1`; Vitest **4.1.11** (5.0.0 was one
  week old); jest-dom **7.0.1** (6.10.0 is deprecated upstream).
- Python 3.14 works with all pinned dependencies (cp314 wheels) — no `uv`/older Python needed.
- Playwright is in CI as a separate job, shell-only (no backend); a full-stack E2E is left to Tasks 04/20.

### Open points / risks
- CI workflow not yet executed on GitHub (nothing pushed, per I-07); action versions `checkout@v5`,
  `setup-python@v6`, `setup-node@v5` and Python 3.14 on `ubuntu-latest` are assumed available.
- One remaining pytest warning comes from Starlette's own test client (`anyio.abc.BlockingPortal` alias), not VIPER code.
- `/api/health` will need to stay unauthenticated when Task 04 protects the API.
- Frontend `Health` type is hand-mirrored from the backend schema; consider OpenAPI type generation later.
