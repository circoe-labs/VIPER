# Database Explorer — reads (Task 11), staged editing (Task 12), read-only SQL console (Task 13)

Route `/database` (`Base de données`). A DBeaver-inspired explorer of VIPER's domain tables: reading (Task 11) and
staged, audited editing (Task 12, section [Staged editing](#staged-editing-task-12)) and a discreet read-only SQL
console (Task 13, section [SQL console](#sql-console-task-13)). Design and trade-offs:
[ADR-0005](../adr/0005-database-explorer-grid.md) (read path), [ADR-0008](../adr/0008-explorer-staged-writes.md)
(write path, concurrency), [ADR-0011](../adr/0011-read-only-sql-console.md) (SQL console).

## What the user can do

| Area | Behaviour |
|---|---|
| Table rail | Exposed tables grouped (Prospects & contacts, Entreprises, Suivi de contact, Référentiels, Imports & journal), technical name + French label + exact row count; accent/case-insensitive filter box; selected table marked (`aria-current`). |
| Grid | Server paging (50 / 100 / 250 / 500 rows per page) with virtualized rows; sticky header showing column name, SQL type, `requis` for NOT NULL, key/FK icons; horizontal + vertical scrolling inside the grid (never the page); row numbers pinned left; primary-key columns pinned by default. |
| Row context | Row number column, status bar with the active row's primary key and column, pages `Lignes 1–100 sur 1 234 (filtrées parmi …)`. |
| Search | Global search box (debounced 300 ms): case-insensitive substring over text, enum, UUID, JSON and array columns. |
| Filters | Per-column popover (filter icon or column menu): condition list valid for the column kind, typed input (number, date-time in browser local time, enum/boolean choices, value lists for `fait partie de`). Filters show as removable chips; several filters combine with AND; `Effacer les filtres` clears filters and search. |
| Sort | Click a header: ascending → descending → none. Shift+click adds/cycles a column in a multi-column sort (priority shown). Column menu: sort ascending/descending/remove. |
| Columns | Hide/show, pin/unpin left, move left/right (menu, column chooser, or drag a header onto another one), resize (drag the header edge, double-click = default width, or Shift+← / Shift+→ on a focused header). Layout persisted per table in `localStorage` (`viper.explorer.columns.<table>`), reconciled when the schema changes; `Réinitialiser la disposition`. |
| Long values | Text/JSON longer than 240 characters is cut in pages (ellipsis + expand button); the **value viewer** (drawer) fetches the complete value, pretty-prints JSON, counts characters, copies. The expand button opens it; double-click or Enter open it on a read-only cell (they edit an editable one). |
| Context menu | Right-click, Shift+F10 or the context-menu key on a cell: copy value (Ctrl+C), view full value, copy row as TSV or JSON (displayed columns, display order), filter on / exclude this value (NULL → `est vide` / `n’est pas vide`), open the referenced row (FK), `Lignes liées : <table>` (rows of other tables referencing this row). A truncated preview is never used as a filter value. |
| FK navigation | Opens the target table filtered on its key; the hop is a browser history entry: `Retour à <table>` and browser Back restore the previous table with its filters. FK values render in teal with a link button. |
| Toolbar | Search, `Colonnes` (chooser), `Structure` (metadata drawer), `Exporter CSV`, `Actualiser`. Labels collapse to icons (tooltips + accessible names kept) when the workspace is narrow. |
| Structure | Drawer listing columns (type, NULL, default, keys, allowed values) and the tables referencing this one, with links. |
| States | Loading, empty table, no match (with `Effacer les filtres`), page beyond results, invalid filter (422), API unavailable, unknown or hidden table (`Table introuvable`). |

URL state: `/database/<table>?q=…&sort=a,-b&filters=[…]&page=2&size=250` — reload and deep links restore the view.

Keyboard: arrows, Home/End (Ctrl = first/last cell), PageUp/PageDown (10 rows), Enter, Shift+F10, Ctrl+C; menus
follow the WAI-ARIA menu pattern (arrows, Home/End, Enter, Esc returns focus to the cell). The grid has **two tab
stops**: the header row and the rows, each with a roving focus that follows the active column. In the header row,
← / → / Home / End move between headers, ↓ enters the first row (↑ on the first row comes back); on a header, Enter
sorts, Shift+Enter adds to the sort, Alt+↓ (or Shift+F10 / the context-menu key) opens the column menu — which also
holds *Filtrer…* — and Shift+← / Shift+→ resize by 16 px (announced). The filter and menu icons and the resize edge
stay for the mouse, out of the tab order (I-154).

## Exposure policy

Single source: `backend/app/services/explorer/policy.py`.

- **Tables — default deny.** Exposed: `activity_categories`, `audit_log`, `commercial_segments`, `companies`,
  `company_activity_categories`, `contact_tracking`, `contact_tracking_status_history`, `emails`, `establishments`,
  `import_batches`, `import_row_metadata`, `internal_referents`, `phones`, `prospect_sources`, `prospects`, `roles`.
  Every other ORM table must be listed in `UNEXPOSED_TABLES` with a reason: today the authentication tables
  `users` (argon2 password hashes) and `user_sessions` (session token hashes) — never listed, readable, exported, or
  disclosed as FK targets or references (tested). Anything outside the ORM (`alembic_version`, catalogs, views, ad-hoc tables)
  is unreachable. Not exposed = HTTP 404 everywhere (list, metadata, rows, record, export), and FK targets pointing
  to a hidden table are not disclosed.
- **Columns.** `HIDDEN`: absent from metadata, values, search, filters, sort and export. `MASKED`: listed (marked
  `masquée`) but never read (selected as `NULL`), not searchable, filterable or sortable, exported empty. Primary
  keys cannot be hidden or masked. No column is hidden or masked today.
- `audit_log` is exposed read-only (Task 05 writes it; its payload policy is applied before storage): its `changes`
  and `context` JSONB open pretty-printed in the value viewer, complete even when the page preview is cut.
- Editability lives in the same policy (`TableWrites`, `ColumnPolicy.edit`), see
  [Editability policy](#editability-policy). The explorer's exposure policy is a separate axis from Task 05's audit
  classification (`AUDITED_ENTITIES` / `NOT_AUDITED_TABLES`); both are test-enforced, and a test ties them: a table
  outside the audit registry cannot be written by the explorer unless its writes go through an audited owner.

## API (reads, `GET`)

| Endpoint | Returns |
|---|---|
| `/api/explorer/tables` | `[{name, row_count}]` (exact counts) |
| `/api/explorer/tables/{table}` | `{name, row_count, primary_key, columns[], referenced_by[], update_refused, insert_refused, delete_refused, bulk_delete, version_column, label_columns}`; column = `name, sql_type, kind, nullable, default, primary_key, foreign_key{table,column}, allowed_values, masked, filter_operators, sortable, searchable, updatable, insertable, read_only_reason, required_on_insert` (`*_refused` / `read_only_reason`: `null` when allowed, else the French reason) |
| `/api/explorer/tables/{table}/rows?offset&limit&q&sort&filter` | `{total, offset, limit, rows: [{values, truncated}]}`; `limit` 1–500 (default 100); `sort` repeated, `-col` = descending; `filter` = JSON AST |
| `/api/explorer/tables/{table}/record?key={"id": "…"}` | `{values}` — one full row by primary key (composite keys supported) |
| `/api/explorer/tables/{table}/export.csv?q&sort&filter` | streamed CSV of all matching rows |

Errors: 404 for unknown/unexposed tables or missing records; 422 for invalid parameters (unknown column, operator not
allowed for the kind, wrong value type, limits exceeded). The routes sit on the protected `api_router`: without a
live session every explorer endpoint answers 401 (ADR-0004; pinned by `tests/test_route_protection.py`).

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

## Staged editing (Task 12)

Nothing is written while the user edits: changes are **staged in the browser** (per table) and sent together by
`Enregistrer`, applied **all or nothing** in one transaction, each changed row audited with the signed-in user and
`source = database_explorer`.

| Area | Behaviour |
|---|---|
| Edit a cell | Double-click, Enter or F2 on an editable cell (typing a character on a text/number cell starts editing with it); context menu `Modifier la cellule`, `Mettre à NULL`. Typed editors: text field (varchar length checked), multi-line field for `text` columns (Shift+Enter = new line), number, `datetime-local` (browser local time, sent as UTC ISO 8601), date, choice list for enums and booleans, foreign-key picker (search the referenced table by its label columns, or paste an identifier). Nullable columns have a `NULL` button; an emptied nullable field means NULL. A truncated value is loaded in full before editing. Enter commits, Tab / Shift+Tab commit and move, **Esc cancels**, leaving the cell commits a valid value (an invalid one is dropped and its error shown). |
| Staged state | Modified cell: amber tint + pencil marker (tooltip: original value), text « Modifiée » for screen readers; new row: `+` marker and tint, at the top of the grid; row to delete: struck through + trash marker. Typing the original value back un-stages the cell. Staged changes survive paging, sorting, filtering and refresh on the same table. |
| Pending bar | `N modifications en attente` with the breakdown (cells, rows added, deletions), `Voir le détail` (drawer listing every change, before → after, with per-cell / per-row undo and the server errors), `Annuler` (discards everything, original values back), `Enregistrer`. |
| Add row | `Ajouter une ligne` (only where inserts are allowed) opens the editor on the first required column. |
| Record editor | On `companies` rows, the context menu offers `Ouvrir dans l’éditeur`: the Company editor (Task 07) opens as a drawer; the grid reloads after a save or a deletion. |
| Delete | Context menu `Supprimer la ligne…` (or the selected rows); row checkboxes + `Supprimer (N)` in the toolbar. Several rows at once only on tables where no deletion cascades (`bulk_delete`). A confirmation dialog first asks the server what the deletion would do: blockers (RESTRICT references, do-not-contact prospect) disable the confirmation; CASCADE and SET NULL effects are listed (cascades of cascades included) and the button then says `Supprimer avec les lignes liées`. Confirming stages the deletion. |
| Errors | A refused save changes nothing; the bar turns red (`Enregistrement refusé : N erreurs`), each error is shown on its cell (red outline + alert marker + tooltip) or on its row header, and in the review drawer. Editing the cell clears its error. |
| Read-only | Read-only cells explain why in a tooltip, F2 announces the reason, the context menu shows `Lecture seule : <raison>`; read-only columns of writable tables carry a lock in their header; fully read-only tables show a `Lecture seule` badge. |
| Leaving | With staged changes, leaving the table (rail, relationship link, `Retour à …`, browser Back, another page) asks `Modifications non enregistrées` → `Rester sur <table>` / `Quitter sans enregistrer`; reload/close triggers the browser's prompt. |

### Editability policy

Single source: `backend/app/services/explorer/policy.py` (`TableWrites` per table, `ColumnPolicy.edit` per column),
combined with structural rules in `metadata.py`. **Default deny**: an exposed table is read-only unless listed.

| Table | Update | Insert | Delete | Column rules |
|---|---|---|---|---|
| `roles`, `commercial_segments`, `activity_categories` | yes | yes | yes (blocked while referenced: deactivate instead) | `slug` set at creation only |
| `internal_referents` | yes | yes | yes (blocked while referenced) | — |
| `companies` | yes | yes | yes, single row (blocked by prospects; cascades establishments and category links) | — |
| `company_activity_categories` | no (add or remove the link) | yes | yes | written through the company's collection, audited as `company.updated` (`activity_categories_ids`) |
| `establishments` | yes | yes | yes | `company_id` set at creation only |
| `prospects` | yes | **no** — created from Prospection (provenance) | yes, single row (cascades its emails, phones, tracking, sources, import rows); **never a do-not-contact prospect** | `contactability_status`, `do_not_contact_at`, `do_not_contact_reason` read-only (« utilisez la fiche prospect »); `company_id` goes through the company-change rule (I-13) and cannot be emptied |
| `emails`, `phones` | yes | yes | yes | `prospect_id` set at creation only |
| `contact_tracking` | yes | yes | yes, single row (cascades its history) | writes go through `save_contact_tracking` (status history kept); one row per prospect; `prospect_id` set at creation only |
| `prospect_sources` | only `legal_basis_or_collection_context`, `notes` | no | no | origin, reference, batch, dates and actor are the provenance trace |
| `import_batches`, `import_row_metadata`, `contact_tracking_status_history`, `audit_log` | no | no | no | written by the import / derived / append-only |

Structural rules on every table: generated primary keys, `created_at`/`updated_at`, JSON and array columns, masked
columns and references to unexposed tables are read-only; primary keys without a default (link table) are set at
creation only; a column is required on insert when it is NOT NULL without any default.

### Write API

| Endpoint | Behaviour |
|---|---|
| `POST /api/explorer/tables/{table}/changes` | Body `{updates: [{key, version, values}], inserts: [{values}], deletes: [{key, version}]}` (≤ 500 changes). `200 {updated, inserted, deleted, inserted_keys}`; `422` (or `409` when a row changed meanwhile) `{"detail": {"message", "errors": [{operation, index, column, code, message}]}}` — nothing applied. CSRF token required (403), session required (401). |
| `GET /api/explorer/tables/{table}/delete-check?key=…&key=…` | `{rows, allowed, blockers[], effects[{table, column, action: restrict / cascade / set_null, count, depth}]}` for 1–100 rows; read-only. Unexposed referencing tables are counted without being named. |

Validation (per change and per column, all errors collected): table operation allowed, key complete and typed,
version present where the table has one, column known and editable, value of the column's type (text length,
enum value, integer range, ISO datetime with offset, date, UUID, boolean), NOT NULL, required columns of a new row,
same row listed twice. Then, under row locks (`SELECT … FOR UPDATE`): row still exists, **version unchanged**,
foreign-key targets exist, domain blockers (do-not-contact deletion, second tracking row, existing category link,
detaching a prospect from its company). Application order: deletes, updates, inserts, each in a savepoint; a change
refused by the database is retried after the others (e.g. moving the primary e-mail from one address to another in
either order), until a pass makes no progress.

**Concurrency** (ADR-0008): optimistic, per row. The client sends back the `updated_at` it read (`version_column`);
if the row was changed since (the trigger bumps `updated_at` on every UPDATE), the save is refused with `409`
« Ligne modifiée entre-temps : actualisez la table puis refaites la modification ». Tables without `updated_at`
(the link table) have no version.

**Error messages** — database refusals are translated per constraint (`writes.CONSTRAINT_MESSAGES`; a test requires
every UNIQUE/CHECK of a writable table to have one), e.g. « Un e-mail principal actif existe déjà pour ce prospect. »,
« Ce SIREN est déjà utilisé par une autre entreprise. », « Le SIREN compte exactement 9 chiffres. », « Ce prospect a
déjà cette adresse e-mail. »; enum CHECKs → « Valeur non autorisée. »; foreign keys → « Aucune ligne de roles ne porte
cet identifiant. » / « Suppression bloquée : des lignes de prospects la référencent encore. »; the do-not-contact
trigger → « Ce prospect est en opposition : utilisez la fiche prospect … ».

**Audit** — every row written goes through the ORM in the request's transaction: one event per row, actor = the
signed-in user, `context.source = database_explorer`, `request_id` shared by the whole save. Company changes are
`prospect.company_changed`, tracking stage changes `contact_tracking.status_changed`. Rows removed by `ON DELETE
CASCADE` are not audited one by one (the deleted parent is; ADR-0006) — the confirmation dialog says so.

## Limits and known gaps

- Totals use exact `count(*)` — right for V1 volumes (a 50k-row filtered, sorted deep page stays well under 2 s in
  tests); very large tables would need estimates or keyset paging.
- Offset paging; the explorer's substring search (`ILIKE` on raw columns) has no index of its own — the trigram
  indexes of Task 17 serve the global search's folded keys ([ADR-0017](../adr/0017-global-search-trigram-indexes.md)).
- The column chooser and menus are keyboard-operable; drag-and-drop reorder has menu equivalents.
- Copying a truncated cell copies the preview (labelled as such); the value viewer copies the full value.
- Editing: one table at a time (staged changes are dropped when leaving the table after confirmation); no bulk
  "fill down" or paste of several cells; JSON/array values are read-only; no value normalization (an e-mail with
  capitals is refused with the CHECK message rather than lower-cased); a new row appears in its sorted place only
  after saving; the row selection is per page.
- No schema editing; the SQL console is read-only (below).

## SQL console (Task 13)

`Console SQL` (page header of `/database`) opens a drawer: a monospace query field, `Exécuter` or **Ctrl+Entrée**,
then the result table (column names and PostgreSQL types, NULL shown as such, numbers right-aligned, row count and
duration) or the error (French message, PostgreSQL's own message, and the faulty position selected in the query).
The query text is kept while the page stays open. No tabs, history or autocompletion.

| Capability / limit | Value |
|---|---|
| Statements | one `SELECT`, `WITH … SELECT`, `VALUES`, `TABLE` or `EXPLAIN` (a trailing `;` is fine) |
| Data | committed rows of the **exposed tables only**, visible and unmasked columns only; never `users`, `user_sessions`, `alembic_version`; catalog *names* stay readable |
| Rows | first 1 000 (`VIPER_SQL_MAX_ROWS`) — « Résultat tronqué » beyond; the server never sends more |
| Cells | 500 characters, then cut and flagged (`…`) |
| Time | 5 s per query (`VIPER_SQL_STATEMENT_TIMEOUT_MS`; the role's own default is 10 s) |
| Query text | 20 000 characters |
| Writes | impossible: the reader role has no write privilege, the transaction is read-only, data-modifying CTEs are refused by the cursor, several statements by the protocol |

**Security boundary** — the database role `viper_sql_reader` (ADR-0011): login only, no membership, read-only
default transaction, statement/idle/lock timeouts, column-level `SELECT` on exactly the exposed columns (a test
compares its privileges with the exposure policy). Each query runs on its own connection (closed afterwards), in a
`READ ONLY` transaction with `SET LOCAL statement_timeout`, as a prepared statement through a server-side cursor.
The early checks (empty text, several statements, not a read) only produce clearer messages.

**Errors** — « Saisissez une requête SQL. », « Une seule instruction à la fois… », « La console est en lecture
seule : SELECT, WITH, VALUES, TABLE ou EXPLAIN uniquement. », « Erreur de syntaxe à la position N. », « Table non
accessible : la console ne lit que les tables exposées de l’explorateur. », « Accès refusé : fonction ou opération
réservée à l’administration de la base. », « Écriture refusée : la console est en lecture seule. », « Requête
interrompue : elle a dépassé 5 s. », « Table inconnue. » / « Colonne inconnue. » / « Fonction inconnue… »;
« Console SQL indisponible… » (HTTP 503) when the reader role is missing or its password is wrong.

**API** — `POST /api/explorer/sql` `{sql}` → `200 {columns: [{name, type}], rows, truncated_cells, row_count,
truncated, max_rows, duration_ms}`; `422 {"detail": {code, message, detail, position}}`; `503` when unavailable;
session and CSRF token required. Values are JSON-safe: timestamps ISO 8601, integers beyond 2^53 and numerics as
text, `bytea` as hexadecimal text, JSON as text.

**Audit** — every attempt, accepted or refused, is an `explorer.sql_executed` event (source `database_explorer`,
signed-in actor) with `query_sha256`, `query_length`, `outcome` (`ok` or the error code) and, when it ran,
`row_count`, `truncated`, `duration_ms`. The query text itself is **not** stored (it may contain personal values;
decision I-67).

**Provisioning** — `python -m app.cli provision-sql-reader` (from `backend/`, targets `VIPER_DATABASE_URL`) creates or
aligns the role and resets its grants; idempotent; **run it after every migration** (grants follow the tables). It
needs `CREATEROLE` to create the role; without it, the command prints the SQL an administrator must run (password
elided) and, once the role exists, applies the grants (the application role owns the tables). The test suite and the
Playwright setup provision their databases themselves. The role is shared by every database of the PostgreSQL
cluster, so runs are serialized by `provisioning_lock`: an advisory lock held in the `postgres` maintenance database
(advisory locks are per database) until the provisioning transaction has committed, or in the target database when
the role may not connect to `postgres` (decision I-151). Parallel checkouts, pytest and the E2E setup can therefore
provision at the same time without « tuple concurrently updated ».

## Code map

| Concern | Where |
|---|---|
| Exposure and editability policy | `backend/app/services/explorer/policy.py` |
| Metadata / kinds / operators / editability | `backend/app/services/explorer/metadata.py` |
| Change sets (model, validation) | `backend/app/services/explorer/changes.py` |
| Applying writes, French error messages | `backend/app/services/explorer/writes.py` |
| Delete diagnostics | `backend/app/services/explorer/deletion.py` |
| SQL console: reader role and grants, execution, route | `backend/app/services/explorer/sql_reader.py`, `sql_console.py`, `backend/app/api/routes/explorer_sql.py`, `app/cli.py` (`provision-sql-reader`) |
| SQL console UI | `frontend/src/database/SqlConsole.tsx` |
| Write routes | `backend/app/api/routes/explorer_writes.py` |
| Staged changes (store), editing rules | `frontend/src/database/staging.ts`, `editing.ts` |
| Editors, pending bar, delete dialog, leave guard | `frontend/src/database/CellEditor.tsx`, `PendingChanges.tsx`, `DeleteRowsDialog.tsx`, `UnsavedChangesGuard.tsx` |
| Filter AST + validation | `backend/app/services/explorer/query.py` |
| SQL statements | `backend/app/services/explorer/statements.py` |
| Read operations, CSV | `backend/app/services/explorer/reads.py` |
| Routes | `backend/app/api/routes/explorer.py` |
| Page, rail, workspace | `frontend/src/database/DatabasePage.tsx`, `TableRail.tsx`, `TableWorkspace.tsx` |
| Grid, header, menus | `frontend/src/database/ExplorerGrid.tsx`, `GridHeader.tsx`, `cellMenu.ts`, `src/ui/Menu.tsx`, `src/ui/Popover.tsx` |
| View/URL state, filters, column layout | `frontend/src/database/explorerView.ts`, `filters.ts`, `columnState.ts` |
| API client | `frontend/src/api/explorer.ts` |
| Tests | `backend/tests/test_explorer_*.py` (writes: `test_explorer_writes.py`, `test_explorer_editability.py`); `frontend/src/database/*.test.ts(x)` (editing: `staging.test.ts`, `editing.test.ts`, `TableEditing.test.tsx`; SQL: `SqlConsole.test.tsx`), `backend/tests/test_explorer_sql.py` (reader role, grants, security regression suite); `frontend/e2e/database.spec.ts`, `database-edit.spec.ts`, `database-sql.spec.ts` (synthetic dataset `backend/tests/fixtures/synthetic/explorer_dataset.py`) |
