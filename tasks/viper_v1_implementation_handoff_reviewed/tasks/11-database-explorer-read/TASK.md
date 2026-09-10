# Task 11 — Implement Database Explorer read/metadata/grid foundation

## Goal
Build the DBeaver-inspired read-only exploration foundation before adding mutation and SQL complexity.

## Context
Database Explorer is a core user feature. It must use most screen space and remain pleasant with many columns/rows.

## Coding Skill Requirement
Before editing code, load and follow `/caveman` and `/coding-guideline` from `~/ai/skills/`.

## Scope
### In Scope
- Left table rail/search/counts.
- Metadata endpoint (columns/types/nullability/PK/FK).
- Paginated/virtualized grid.
- Sticky headers and horizontal scroll.
- Search/filter/multi-sort.
- Hide/show/reorder/resize/pin columns with local persistence.
- Long-value viewer.
- Copy cell/row/filter-by-value.
- FK navigation.
- Refresh/filtered export.

### Out of Scope
- No writes yet.
- No SQL console yet.
- No schema designer.

## Dependencies
Tasks 02-03.

## Implementation Steps
1. Metadata service.
2. Safe parameterized table reader/filter AST.
3. Rail + grid.
4. Column state interactions.
5. Value viewer/context actions.
6. FK navigation/refresh/export.
7. Performance tests.

## Files Likely Touched
Database page/components, explorer read service, query/filter types, tests.

## Architecture Constraints
Never concatenate untrusted filters into SQL. Explorer adapter is separate from business services. Large datasets use server paging/virtualization.

## Testing Requirements
Injection-safe filters, paging, sort/filter combinations, column state, long values, FK navigation, large synthetic dataset performance.

## Acceptance Criteria
- User can inspect any allowed table fluidly.
- Required DBeaver-like read ergonomics work.
- No write path exists yet.

## Documentation Updates
Document supported read features.

## Handoff Notes
Global visual reference: `../../visuals/neon-command-brand-direction.png`.

## Implementation report

Implemented on branch `task-11-explorer` (worktree `C:\Projects\VIPER-wt-explorer`), backend + frontend + docs.
Design and trade-offs: `doc/adr/0005-database-explorer-grid.md`; user-facing behaviour and limits:
`doc/features/database-explorer.md`; decisions I-40 … I-46.

### What was done
- **Exposure policy** (`backend/app/services/explorer/policy.py`) — default deny: `EXPOSED_TABLES` allowlists the 16
  domain tables; every other ORM table must be listed in `UNEXPOSED_TABLES` with a reason (test-enforced), so the
  Task 04 `users`/`sessions` tables stay invisible; `alembic_version` and anything outside the ORM are unreachable
  (404 on every endpoint). Column hook `ColumnPolicy(visibility=VISIBLE|MASKED|HIDDEN)` (unused today; PKs cannot be
  hidden); Task 12 adds editability to the same object.
- **Metadata** (`metadata.py`) — from the ORM (kept equal to the schema by the migration drift test): SQL type, value
  kind, nullability, server default, PK, FK target (only when exposed), CHECK value lists, incoming references,
  operators per kind, exact row counts (all tables in one round trip).
- **Read service** (`query.py`, `statements.py`, `reads.py`) — typed filter AST (`condition`/`group`, and/or, depth ≤ 4,
  ≤ 50 conditions) validated against metadata (unknown/hidden/masked columns, operator/kind mismatches, value types →
  422), compiled to SQLAlchemy Core with bound parameters only; ILIKE with `autoescape` for contains/starts_with and
  the global search (text, enum, UUID, JSON, array columns); multi-column sort always closed by the PK; offset paging
  (≤ 500); values > 240 chars truncated and flagged; full record by primary key (composite keys supported);
  streamed CSV (BOM, `;`, CRLF, formula neutralization, hidden absent / masked empty).
- **API** (`backend/app/api/routes/explorer.py`) — `GET /api/explorer/tables`, `/tables/{t}`, `/tables/{t}/rows`,
  `/tables/{t}/record`, `/tables/{t}/export.csv`; GET only (no CSRF surface); policy injectable for tests.
- **Database page** (`frontend/src/database/`, route `/database/:table?`) — grouped table rail (French labels,
  counts, accent-insensitive filter); server-paged, row-virtualized grid on headless TanStack Table 8.21.3 +
  TanStack Virtual 3.14.11: sticky two-line headers (name + SQL type, PK/FK icons), row numbers + PK pinned left,
  per-column filter popover typed by kind, filter chips, debounced global search, multi-sort (Shift+click, priority
  badges), hide/show/pin/move (menu, column chooser, drag-and-drop), resize (drag, double-click reset, keyboard on
  the separator), layout persisted per table in `localStorage`; value viewer drawer (fetches the full value,
  pretty-prints JSON); structure drawer; context menu (right-click / Shift+F10 / context-menu key): copy cell, copy
  row TSV/JSON, filter on/exclude value, open referenced row, rows of referencing tables, view full value; FK
  navigation through the URL with `Retour à …` and browser Back; toolbar (search, Colonnes, Structure, Exporter CSV,
  Actualiser) collapsing to icons in a narrow workspace (container query); loading/empty/no-match/invalid/error/
  unknown-table states. View state (search/sort/filters/page) in the URL. New accessible primitives `Menu` and
  `Popover` (+ 17 icons), added to the `/_dev/ui` showcase. No write affordance.
- **Test/dev infrastructure** — synthetic dataset `backend/tests/fixtures/synthetic/explorer_dataset.py`;
  `python -m tests.e2e_server --port N` (resets the `*_test` DB, seeds, serves the API); Playwright starts it plus
  its own Vite on 5180/8180 (`VIPER_E2E_*` overridable); Vite ports env-configurable (`VIPER_WEB_PORT`,
  `VIPER_API_TARGET`); CI e2e job gained Postgres + Python; `stubApi` routed fetch stub for component tests; shared
  `reset_database` / `require_test_database` helpers in `tests/support.py`.

### Files
Backend: `app/services/explorer/{__init__,policy,metadata,query,statements,reads}.py`, `app/api/routes/explorer.py`,
`app/api/router.py`, `app/services/errors.py` (`InvalidInputError`); tests `tests/test_explorer_{policy,metadata,reads,
export,performance}.py`, `tests/explorer_helpers.py`, `tests/e2e_server.py`, `tests/fixtures/synthetic/`,
`tests/support.py`, `tests/conftest.py`.
Frontend: `src/database/*` (page, rail, workspace, grid, header, filter editor, columns panel, value viewer,
structure, view/filter/column-state/cell/navigation/catalog logic + tests, `database.css`), `src/api/explorer.ts`,
`src/ui/{Menu,Popover}.tsx`, `floating.ts`, `menu.css`, `popover.css`, `icons.tsx`, `src/routes.tsx`,
`src/test/{render.tsx,explorerFixtures.ts}`, `src/shell/AppShell.test.tsx` (routes its `/database` renders through
`stubApi` now that the page loads tables), `src/dev/Showcase.tsx`, `e2e/database.spec.ts`, `e2e/helpers.ts`,
`vite.config.ts`, `playwright.config.ts`, `package.json` / lockfile. CI: `.github/workflows/ci.yml`.
Docs: ADR-0005, `doc/features/database-explorer.md`, decision log I-40…I-46, runbook (ports, parallel checkouts,
synthetic server), testing strategy, design system (Menu, Popover, icons, grid styling), interface spec, overview,
security & privacy.

### Tests run
- `VIPER_E2E_WEB_PORT=5174 VIPER_E2E_API_PORT=8043 python scripts/verify.py --e2e` (worktree, databases
  `viper_wt` / `viper_wt_test`) → all gates green: privacy guard, ruff, ruff format, mypy (69 files), **pytest 151
  passed** (76 new), eslint, tsc, **vitest 246 passed** (44 new, 16 files), vite build, **Playwright 13 passed**
  (6 new explorer scenarios).
- Performance: 50 000 synthetic companies, filtered (group of 2 conditions) + searched + 2-key sort, page at offset
  5 000 → ~1.4 s for the whole test locally including the insert; assertion budget 2 s for the page call, 10 s for
  the streamed export of the filtered rows.
- Visual check: screenshots at 1440×900 dark/light (grid, context menu, value viewer, filter popover, column
  chooser, structure drawer, horizontal scroll with pinned columns) and 1280×800 reviewed; cramped points fixed
  (UUID middle-ellipsis, overlay cell actions, compact toolbar in narrow workspaces, single-line status bar, page
  fills the viewport).

### Deviations / decisions
- I-40 … I-46 (policy, adapter building its own Core statements instead of `app/repositories`, filter semantics and
  exact counts, CSV format and formula neutralization, truncation, URL/localStorage state, TanStack 8 + env ports +
  Playwright full stack).
- The handoff's "column state persisted" is per browser (`localStorage`), not per user account (no accounts yet).

### Open points / risks
- **Merge with Task 04**: add the authentication tables (e.g. `users`, `sessions`) to `UNEXPOSED_TABLES` with their
  reason — `test_every_orm_table_is_explicitly_exposed_or_withheld` fails until then (by design). Add the login step
  to `frontend/e2e/helpers.ts::openDatabase` (and to the explorer screenshots) once the API requires a session; the
  Playwright webServer config may need to merge with whatever Task 04 adds.
- Keyboard: each header exposes sort, filter, menu and resize controls as separate tab stops (many stops on wide
  tables); cells use roving focus. A composite header navigation could reduce tab stops later.
- Copying a truncated cell copies the preview (labelled); the value viewer copies the full value.
- Scaling limits: exact counts, offset paging, unindexed substring search (Task 17 decides on `pg_trgm`).
- The E2E API server resets the `*_test` database: never run it concurrently with pytest on the same database.
