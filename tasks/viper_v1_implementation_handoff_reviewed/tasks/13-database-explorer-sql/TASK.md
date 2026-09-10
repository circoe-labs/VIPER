# Task 13 — Add backend-enforced read-only SQL console

## Goal
Provide the discreet advanced SQL query surface requested by the user without turning VIPER into a SQL IDE or write backdoor.

## Context
SQL is a power-user Database feature. It must remain read-only in V1 and safely resource-bounded.

## Coding Skill Requirement
Before editing code, load and follow `/caveman` and `/coding-guideline` from `~/ai/skills/`.

## Scope
### In Scope
- Compact SQL editor/field.
- Execute SELECT/read-only query.
- Render result grid.
- Server-side read-only enforcement.
- Parameter/resource/time/row limits appropriate to stack.
- Clear errors.

### Out of Scope
- No UPDATE/DELETE/INSERT/DDL.
- No multi-statement write tricks.
- No migration/schema editor.

## Dependencies
Tasks 11-12.

## Implementation Steps
1. Choose parser/database-enforced read-only strategy.
2. Build execution service with limits.
3. Add UI/result grid.
4. Add security regression suite.

## Files Likely Touched
SQL explorer service, UI console, tests.

## Architecture Constraints
Frontend checks are insufficient; backend/database role must prevent writes. Avoid exposing secrets/system tables if platform requires restrictions.

## Testing Requirements
Blocked DML/DDL/multi-statement attempts, valid SELECT, limits/timeouts, errors, auth required.

## Acceptance Criteria
- SELECT queries work.
- Write attempts are impossible through this path.
- UI remains compact/discreet.

## Documentation Updates
Document SQL capabilities/limits.

## Handoff Notes
Do not overbuild query tabs/history/autocomplete unless trivial and non-distracting.

## Implementation report

Branch `task-12-explorer-edit` (same worktree as Task 12, separate commit), on top of Tasks 11 and 12.

### What was built

- **Database-enforced read-only access** ([ADR-0011](../../../../../doc/adr/0011-read-only-sql-console.md)): a
  dedicated login role `viper_sql_reader` (`app/services/explorer/sql_reader.py`) — LOGIN only (attributes checked,
  any role membership refused), `default_transaction_read_only = on`, `statement_timeout = 10s`,
  `idle_in_transaction_session_timeout = 15s`, `lock_timeout = 2s`, `search_path = public`, connection limit 10 —
  with column-level `SELECT` on exactly the visible, unmasked columns of the explorer-exposed tables (derived from the
  exposure policy; everything else revoked first). Nothing on `users`, `user_sessions`, `alembic_version`, sequences.
- **Provisioning**: `python -m app.cli provision-sql-reader`, idempotent, to re-run after migrations; creates/aligns
  the role when the connecting role has CREATEROLE, otherwise prints the SQL for an administrator (password elided);
  grants need only table ownership. pytest (module fixture) and the Playwright global setup provision their
  databases. Settings `VIPER_SQL_READER_ROLE`, `VIPER_SQL_READER_PASSWORD` (local-development default only),
  `VIPER_SQL_STATEMENT_TIMEOUT_MS` (5000), `VIPER_SQL_MAX_ROWS` (1000); `.env.example` documents them.
- **Execution** (`sql_console.py`): separate engine as the reader with NullPool (one connection per query, closed
  afterwards), `SET TRANSACTION READ ONLY` + `SET LOCAL statement_timeout`, prepared statement (multi-statement refused
  by the protocol) through a server-side `DECLARE … CURSOR` (writable CTEs refused; at most `max_rows + 1` rows
  fetched), `EXPLAIN` executed directly; JSON-safe values, 500-character cell cap, typed columns (`type_display`).
  Early checks (empty, several statements with a quote/dollar-quote/comment-aware scanner, first keyword not
  SELECT/WITH/VALUES/TABLE/EXPLAIN, 20 000 characters) only for readable messages.
- **Endpoint** `POST /api/explorer/sql` (`explorer_sql.py`, session + CSRF): French errors from SQLSTATE (syntax with
  position, « Table non accessible », admin functions, read-only refusal, timeout, unknown objects), 503 when the
  reader cannot connect. Every attempt audited as `explorer.sql_executed` (new `AuditAction`), source
  `database_explorer`, with SHA-256 and length of the text (never the text), outcome, row count, truncation, duration.
- **UI** (`SqlConsole.tsx`): `Console SQL` button in the Database page header opens a drawer: monospace query field
  (text kept while the page is open), Ctrl+Entrée / `Exécuter`, result table (names + types, NULL, right-aligned
  numbers, `N lignes · durée`, « Résultat tronqué »), error box with PostgreSQL's message and the faulty position
  selected in the query. No tabs, history or autocomplete. Dialog primitive fix: dialogs are capped to the viewport
  and their body scrolls, so long drawers (value viewer included) keep their footer visible.

### Security regression suite (`backend/tests/test_explorer_sql.py`, real database)

- Raw reader connections (no console code in between): INSERT / UPDATE / DELETE / TRUNCATE / DROP / CREATE /
  CREATE TEMP / ALTER / GRANT, `SELECT` from `users` / `user_sessions` / `alembic_version`, `SET ROLE viper`,
  `COPY … TO PROGRAM`, `pg_read_file`, `SET SESSION CHARACTERISTICS … READ WRITE; INSERT …`, `nextval` → all refused
  with SQLSTATE 42501 / 25006.
- Through the endpoint: early refusals (empty, comments only, `SELECT 1; DELETE …`, every write/DDL/`SET ROLE` /
  `RESET` / `COPY` / `DO` / `CALL`, too long); database refusals (`FOR UPDATE`, writable CTE, `EXPLAIN ANALYZE DELETE`,
  `SELECT … INTO`, hidden tables, `pg_authid`, `pg_read_file`, `lo_import`, `dblink` (not installed), `nextval`,
  `pg_terminate_backend` of other sessions); `set_config(...)` and `pg_advisory_lock` harmless (connection closed, lock
  released — checked); `pg_sleep` beyond the timeout, also with `set_config('statement_timeout','0')` inside the query;
  5 000-row result cut at 1 000 with long cells cut; syntax error position; audit event without the text (a personal
  literal in the query is absent from the event); 401 without session, 403 without CSRF; 503 with a wrong reader
  password; provisioning revokes extra grants, masks masked/hidden columns, refuses a role with memberships, explains
  what to run without CREATEROLE; reader grants == exposure policy.

### Files

Backend: `app/services/explorer/{sql_reader,sql_console}.py`, `app/api/routes/explorer_sql.py`, `app/api/router.py`,
`app/main.py` (reader engine), `app/core/config.py`, `app/cli.py`, `app/services/audit.py` (action), `.env.example`;
tests `tests/test_explorer_sql.py`, `tests/test_cli.py` (+1), `tests/test_explorer_reads.py` (route inventory).
Frontend: `src/database/SqlConsole.tsx` (+ test), `DatabasePage.tsx`, `database.css`, `src/api/explorer.ts`,
`src/ui/{icons.tsx,dialog.css}`, `e2e/database-sql.spec.ts`, `e2e/global-setup.ts`. Docs: ADR-0011, ADR-0005
(amended line), `doc/features/database-explorer.md` (SQL section), `architecture/{security-and-privacy,overview,
audit-and-provenance}.md`, `features/interface-spec.md`, runbook, decision log I-67 … I-69.

### Tests run

`python scripts/verify.py --e2e` with the worktree overrides (`VIPER_E2E_DATABASE_URL=…/viper_wt_e2e`,
`VIPER_E2E_WEB_PORT=5184`, `VIPER_E2E_API_PORT=8143`): all gates green — counts in the final message to the
orchestrator.

### Deviations / decisions

Decision log I-67 … I-69: role-based boundary with hash-only audit; explicit provisioning command instead of a
migration (no Docker init change needed: the command creates the role with the local superuser); limits; catalog
names readable. The ADR is numbered 0011 as requested (0009/0010 left to other branches).

### Open points

- Production must set `VIPER_SQL_READER_PASSWORD` and run `provision-sql-reader` after each migration (documented);
  a forgotten run degrades to « Table non accessible » / 503, never to more access.
- The reader sees catalog metadata (object names) like any PostgreSQL role.
- No per-user rate limit on the console (single-user pilot; timeouts and the connection limit bound the load).
