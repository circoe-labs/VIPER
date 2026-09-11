# ADR-0005 — Database Explorer: policy-driven read API and headless virtualized grid

- Status: accepted
- Date: 2026-09-10
- Deciders: Task 11 (Database Explorer read), for orchestrator review
- Related: `doc/features/database-explorer.md`, `doc/product/decision-log.md` (I-40 … I-46), ADR-0001 (stack),
  ADR-0003 (styling), Tasks 12 (staged edits) and 13 (read-only SQL console)
- Amended: 2026-09-10 by Task 12 ([ADR-0008](0008-explorer-staged-writes.md)) — `ColumnPolicy` gains editability and
  `TablePolicy` a default-deny `TableWrites`; staged writes use a separate router (`explorer_writes.py`); the read
  routes stay GET-only.
- Amended: 2026-09-10 by Task 13 ([ADR-0011](0011-read-only-sql-console.md)) — the SQL console's database role gets
  column `SELECT` grants derived from this exposure policy.
- Amended: 2026-09-11 by Task 17 ([ADR-0017](0017-global-search-trigram-indexes.md)) — `pg_trgm` is decided for the
  global search's folded keys; the explorer's own `ILIKE` search keeps no dedicated index.

## Context

The user asked for a serious, DBeaver-like explorer — not a toy admin table: a large grid using most of the screen,
server paging, multi-sort, per-column filters, hide/reorder/resize/pin with persistence, a long-value viewer,
copy/filter-by-value context actions, FK navigation, metadata and filtered export. It must stay safe on a public
codebase with personal data: it must never show authentication secrets (Task 04 adds users/sessions tables at the
same time), never concatenate client input into SQL, and leave room for Task 12 (per-column editability, staged
writes) and Task 13 (read-only SQL console) without becoming a write backdoor.

Two decisions are needed: how the backend decides and serves what may be read, and which grid technology renders it.

## Decision

### Backend — a self-contained read adapter

`backend/app/services/explorer/` is a generic adapter, separate from the business services (it never calls them):

| Module | Role |
|---|---|
| `policy.py` | **Default-deny exposure policy.** `EXPOSED_TABLES` allowlist (16 domain tables); every other ORM table must be listed in `UNEXPOSED_TABLES` with a reason (a test fails otherwise). Per-column `ColumnPolicy` with `HIDDEN` / `MASKED` visibility; Task 12 adds editability to the same object. |
| `metadata.py` | Describes exposed tables from the ORM metadata (kept equal to the migrated schema by `test_migrations.py`): SQL type, value *kind*, nullability, server default, PK, FK target (only if exposed), CHECK value list, incoming references, allowed filter operators per kind. |
| `query.py` | Typed filter AST (`condition` / `group` with `and`/`or`, depth ≤ 4, ≤ 50 conditions, ≤ 100 `in` values), sort keys and search, validated against the metadata: unknown/hidden/masked columns and operator/kind mismatches are rejected, values are parsed to the column's Python type. |
| `statements.py` | Turns validated queries into SQLAlchemy Core statements over the policy-approved `Table` objects: bound parameters only, ILIKE with `autoescape`, primary key appended to every ORDER BY, masked columns selected as `NULL`. |
| `reads.py` | Entry points: table list with exact counts (one round trip), row pages (text/JSON > 240 chars truncated and flagged), full record by primary key, streamed CSV. |

HTTP: `GET /api/explorer/tables`, `/tables/{table}`, `/tables/{table}/rows`, `/tables/{table}/record`,
`/tables/{table}/export.csv` — **GET only**; the filter AST travels as a JSON query parameter, so no CSRF surface and
bookmarkable exports. Everything not exposed answers 404; invalid queries 422.

### Frontend — headless TanStack Table 8 + TanStack Virtual 3

`@tanstack/react-table` **8.21.3** and `@tanstack/react-virtual` **3.14.11** (both MIT, pinned). The grid
(`frontend/src/database/`) is our own markup and Neon Command CSS on top of TanStack's column model:

- server paging (50/100/250/500 rows) with virtualized rows inside the page (CSS-grid table, absolutely positioned
  rows), sticky header, left pinning with sticky offsets, `onChange` resizing (+ keyboard resize on the header
  separator), HTML5 drag-and-drop reorder plus menu/keyboard alternatives;
- WAI-ARIA grid semantics: `role="grid"`, row/column counts, row headers, roving focus (arrows, Home/End,
  PageUp/Down, Enter = value viewer, Shift+F10 / context-menu key = actions, Ctrl+C = copy);
- context actions come from a pure, unit-tested builder (`cellMenu.ts`) rendered by a new accessible `Menu`
  primitive; filter editor and column chooser use a new non-modal `Popover` primitive (`src/ui/`);
- what the grid shows (search, sort, filters, page) lives in the URL, so reload, deep links and browser Back after
  an FK hop work; column layout is per table in `localStorage`.

## Consequences

- New tables are invisible until someone classifies them (the classification test fails until then — intended);
  Task 04's `users` and `user_sessions` are withheld in `UNEXPOSED_TABLES`. The routes are on the session-protected
  `api_router` (ADR-0004).
- The explorer does not use `app/repositories` (it has no domain entities); it is the only place building generic
  table queries, and it only accepts validated query objects.
- Task 12 extends `ColumnPolicy` (editability) and adds a separate write path through validated services; Task 13
  adds its own database-enforced read-only path. Neither widens this read API.
- Exact `count(*)` for totals is fine at V1 scale (thousands of rows; 50k-row test page < 2 s); larger tables would
  need estimates (`pg_class.reltuples`) or keyset paging.
- Offset paging and substring search (`ILIKE '%…%'`, unindexed until Task 17 decides on `pg_trgm`) are the known
  scaling limits.
- Two small runtime dependencies (the production bundle grew from 111 kB to 146 kB gzip with the whole explorer).
  The grid styling is ours, so it follows the design system in both themes without fighting a vendor theme.
- Explorer E2E scenarios need data: the full-stack Playwright setup of Task 04 (own backend and Vite on dedicated
  ports, `viper_e2e` database) also loads the synthetic explorer dataset in its global setup
  (`python -m tests.e2e_data`).

## Alternatives considered

- **AG Grid Community** — mature virtualization, but the context menu, clipboard, range selection and several
  column-menu features are Enterprise-only (paid), its theming fights the token system, and the bundle is several
  times larger. We would have reimplemented the same menus anyway.
- **TanStack Table 9** — available since 2026-08-04, a reworked API one month old; same reasoning as ADR-0001 for
  very fresh majors: revisit on the next dependency refresh.
- **Glide Data Grid / canvas grids** — fast, but canvas rendering weakens accessibility (screen readers, focus,
  text selection) and styling consistency.
- **Hand-written grid without TanStack** — possible, but sizing/pinning/ordering state and resize handling are
  exactly what TanStack Table provides headlessly.
- **POST `/query` with a JSON body** — cleaner for very large filters, but adds a CSRF-protected pseudo-write route
  and prevents plain-link CSV downloads; the AST fits comfortably in a query string (8 kB cap).
- **Reflecting the live database instead of the ORM** — would also see tables outside the application (default
  allow by accident) and loses enum value lists; the migration drift test already guarantees ORM = schema.
