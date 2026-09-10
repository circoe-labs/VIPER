# Database Explorer — read features (Task 11)

Route `/database` (`Base de données`). A DBeaver-inspired, **read-only** explorer of VIPER's domain tables. Staged
edits/deletes arrive with Task 12, the read-only SQL console with Task 13. Design and trade-offs:
[ADR-0005](../adr/0005-database-explorer-grid.md).

## What the user can do

| Area | Behaviour |
|---|---|
| Table rail | Exposed tables grouped (Prospects & contacts, Entreprises, Suivi de contact, Référentiels, Imports & journal), technical name + French label + exact row count; accent/case-insensitive filter box; selected table marked (`aria-current`). |
| Grid | Server paging (50 / 100 / 250 / 500 rows per page) with virtualized rows; sticky header showing column name, SQL type, `requis` for NOT NULL, key/FK icons; horizontal + vertical scrolling inside the grid (never the page); row numbers pinned left; primary-key columns pinned by default. |
| Row context | Row number column, status bar with the active row's primary key and column, pages `Lignes 1–100 sur 1 234 (filtrées parmi …)`. |
| Search | Global search box (debounced 300 ms): case-insensitive substring over text, enum, UUID, JSON and array columns. |
| Filters | Per-column popover (filter icon or column menu): condition list valid for the column kind, typed input (number, date-time in browser local time, enum/boolean choices, value lists for `fait partie de`). Filters show as removable chips; several filters combine with AND; `Effacer les filtres` clears filters and search. |
| Sort | Click a header: ascending → descending → none. Shift+click adds/cycles a column in a multi-column sort (priority shown). Column menu: sort ascending/descending/remove. |
| Columns | Hide/show, pin/unpin left, move left/right (menu, column chooser, or drag a header onto another one), resize (drag the header edge, double-click = default width, or focus the edge and use ← / →). Layout persisted per table in `localStorage` (`viper.explorer.columns.<table>`), reconciled when the schema changes; `Réinitialiser la disposition`. |
| Long values | Text/JSON longer than 240 characters is cut in pages (ellipsis + expand button); the **value viewer** (drawer) fetches the complete value, pretty-prints JSON, counts characters, copies. Double-click or Enter opens it. |
| Context menu | Right-click, Shift+F10 or the context-menu key on a cell: copy value (Ctrl+C), view full value, copy row as TSV or JSON (displayed columns, display order), filter on / exclude this value (NULL → `est vide` / `n’est pas vide`), open the referenced row (FK), `Lignes liées : <table>` (rows of other tables referencing this row). A truncated preview is never used as a filter value. |
| FK navigation | Opens the target table filtered on its key; the hop is a browser history entry: `Retour à <table>` and browser Back restore the previous table with its filters. FK values render in teal with a link button. |
| Toolbar | Search, `Colonnes` (chooser), `Structure` (metadata drawer), `Exporter CSV`, `Actualiser`. Labels collapse to icons (tooltips + accessible names kept) when the workspace is narrow. |
| Structure | Drawer listing columns (type, NULL, default, keys, allowed values) and the tables referencing this one, with links. |
| States | Loading, empty table, no match (with `Effacer les filtres`), page beyond results, invalid filter (422), API unavailable, unknown or hidden table (`Table introuvable`). |

URL state: `/database/<table>?q=…&sort=a,-b&filters=[…]&page=2&size=250` — reload and deep links restore the view.

Keyboard: arrows, Home/End (Ctrl = first/last cell), PageUp/PageDown (10 rows), Enter, Shift+F10, Ctrl+C; menus
follow the WAI-ARIA menu pattern (arrows, Home/End, Enter, Esc returns focus to the cell).

## Exposure policy

Single source: `backend/app/services/explorer/policy.py`.

- **Tables — default deny.** Exposed: `activity_categories`, `audit_log`, `commercial_segments`, `companies`,
  `company_activity_categories`, `contact_tracking`, `contact_tracking_status_history`, `emails`, `establishments`,
  `import_batches`, `import_row_metadata`, `internal_referents`, `phones`, `prospect_sources`, `prospects`, `roles`.
  Every other ORM table must be listed in `UNEXPOSED_TABLES` with a reason — authentication tables (users, sessions,
  password/token hashes) belong there. Anything outside the ORM (`alembic_version`, catalogs, views, ad-hoc tables)
  is unreachable. Not exposed = HTTP 404 everywhere (list, metadata, rows, record, export), and FK targets pointing
  to a hidden table are not disclosed.
- **Columns.** `HIDDEN`: absent from metadata, values, search, filters, sort and export. `MASKED`: listed (marked
  `masquée`) but never read (selected as `NULL`), not searchable, filterable or sortable, exported empty. Primary
  keys cannot be hidden or masked. No column is hidden or masked today.
- Task 12 adds per-column editability to the same `ColumnPolicy`.

## API (read-only, `GET` only)

| Endpoint | Returns |
|---|---|
| `/api/explorer/tables` | `[{name, row_count}]` (exact counts) |
| `/api/explorer/tables/{table}` | `{name, row_count, primary_key, columns[], referenced_by[]}`; column = `name, sql_type, kind, nullable, default, primary_key, foreign_key{table,column}, allowed_values, masked, filter_operators, sortable, searchable` |
| `/api/explorer/tables/{table}/rows?offset&limit&q&sort&filter` | `{total, offset, limit, rows: [{values, truncated}]}`; `limit` 1–500 (default 100); `sort` repeated, `-col` = descending; `filter` = JSON AST |
| `/api/explorer/tables/{table}/record?key={"id": "…"}` | `{values}` — one full row by primary key (composite keys supported) |
| `/api/explorer/tables/{table}/export.csv?q&sort&filter` | streamed CSV of all matching rows |

Errors: 404 for unknown/unexposed tables or missing records; 422 for invalid parameters (unknown column, operator not
allowed for the kind, wrong value type, limits exceeded). Task 04 protects the whole `/api` router.

### Filter AST

```json
{"type": "group", "combinator": "and", "conditions": [
  {"type": "condition", "column": "display_name", "operator": "contains", "value": "fret"},
  {"type": "group", "combinator": "or", "conditions": [
    {"type": "condition", "column": "size_label", "operator": "is_null"},
    {"type": "condition", "column": "rows_total", "operator": "in", "values": [10, 20]}]}]}
```

| Kind (SQL types) | Operators |
|---|---|
| text (`varchar`, `text`) | `contains`, `eq`, `neq`, `starts_with`, `in`, `is_null`, `not_null` |
| enum (`varchar` + CHECK list) | `eq`, `neq`, `in`, `is_null`, `not_null` — values must be allowed |
| integer / number | `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `in`, `is_null`, `not_null` |
| boolean | `eq`, `neq`, `is_null`, `not_null` |
| datetime (`timestamptz`) / date | `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `is_null`, `not_null` — datetimes need an ISO 8601 offset |
| uuid | `eq`, `neq`, `in`, `starts_with`, `is_null`, `not_null` |
| json (`jsonb`) / array (`text[]`) | `contains` (on the text form), `is_null`, `not_null` |

Semantics: `contains` / `starts_with` / search are case-insensitive (`ILIKE`), with `%`, `_` and the escape character
matched literally; they are **not** accent-insensitive. `eq` on text is exact (case-sensitive). `neq` is
`IS DISTINCT FROM`, so rows where the column is NULL are kept. Search and filters combine with AND.

Limits: 4 nesting levels, 50 conditions, 100 `in` values, 1 000 characters per value, 200 for the search, 10 sort
keys, 8 000 characters for the encoded filter, page size 500, offset ≤ 10 000 000. Every ordering ends with the
primary key, so pages are stable and disjoint.

## Export

`Exporter CSV` downloads the **current filter + search + sort** (all pages, streamed server-side with a cursor —
no row cap): UTF-8 with BOM, `;` separator and CRLF so French-locale Excel opens it directly; header = exposed
column names; NULL = empty cell; booleans `true`/`false`; timestamps ISO 8601 with offset; JSON as JSON text.
Text cells that a spreadsheet would evaluate as a formula (starting with `=`, `+`, `-`, `@`, tab, CR — except plain
signed numbers such as `+33100000001`) are prefixed with `'`. Hidden columns are absent, masked ones empty. The
business-oriented Excel export of prospects is a different feature (Task 10).

## Limits and known gaps

- Totals use exact `count(*)` — right for V1 volumes (a 50k-row filtered, sorted deep page stays well under 2 s in
  tests); very large tables would need estimates or keyset paging.
- Offset paging; substring search is not indexed yet (Task 17 decides on `pg_trgm`).
- The column chooser and menus are keyboard-operable; drag-and-drop reorder has menu equivalents.
- Copying a truncated cell copies the preview (labelled as such); the value viewer copies the full value.
- No writes, no SQL, no schema editing (Tasks 12/13).

## Code map

| Concern | Where |
|---|---|
| Exposure policy | `backend/app/services/explorer/policy.py` |
| Metadata / kinds / operators | `backend/app/services/explorer/metadata.py` |
| Filter AST + validation | `backend/app/services/explorer/query.py` |
| SQL statements | `backend/app/services/explorer/statements.py` |
| Read operations, CSV | `backend/app/services/explorer/reads.py` |
| Routes | `backend/app/api/routes/explorer.py` |
| Page, rail, workspace | `frontend/src/database/DatabasePage.tsx`, `TableRail.tsx`, `TableWorkspace.tsx` |
| Grid, header, menus | `frontend/src/database/ExplorerGrid.tsx`, `GridHeader.tsx`, `cellMenu.ts`, `src/ui/Menu.tsx`, `src/ui/Popover.tsx` |
| View/URL state, filters, column layout | `frontend/src/database/explorerView.ts`, `filters.ts`, `columnState.ts` |
| API client | `frontend/src/api/explorer.ts` |
| Tests | `backend/tests/test_explorer_*.py`; `frontend/src/database/*.test.ts(x)`; `frontend/e2e/database.spec.ts` (synthetic dataset `backend/tests/fixtures/synthetic/explorer_dataset.py`) |
