# Task 12 — Add staged editing/deletion to Database Explorer

## Goal
Add safe direct data editing with pending changes, Save/Cancel, validation and audit.

## Context
The user explicitly requires direct edit/delete/copy-like data scientist interactions. Writes must not bypass integrity, audit or suppression semantics.

## Coding Skill Requirement
Before editing code, load and follow `/caveman` and `/coding-guideline` from `~/ai/skills/`.

## Scope
### In Scope
- Inline cell edits.
- Add row where safe.
- Delete row with confirmation and FK diagnostics.
- Staged pending changes bar.
- Save/Cancel transaction.
- Safe context-menu edit/delete.
- Audit all committed mutations.
- Dirty navigation warning.

### Out of Scope
- No arbitrary SQL writes.
- No cascade-delete UI that bypasses domain safeguards.

## Dependencies
Tasks 05 and 11.

## Implementation Steps
1. Define typed staged change set.
2. Implement server validation/apply transaction.
3. Build pending changes UI.
4. Add delete diagnostics/confirmation.
5. Route audit actor/events.
6. Test cancel/save/partial failure.

## Files Likely Touched
Explorer mutation service, grid editing components, audit integration, tests.

## Architecture Constraints
Committed writes are atomic where possible. Do-not-contact and FK rules cannot be bypassed by casual generic updates. Actor trusted server-side.

## Testing Requirements
Edit/cancel/save, invalid type/null, uniqueness conflict, delete with dependencies, audit, navigation dirty warning.

## Acceptance Criteria
- Direct editing works safely.
- Changes remain reversible before Save.
- Destructive actions are explicit.
- Audits exist.

## Documentation Updates
Document write limits/deletion behavior.

## Handoff Notes
If some sensitive columns should be non-editable, centralize that policy rather than hardcoding per grid cell.

## Implementation report

Branch `task-12-explorer-edit` (worktree `C:\Projects\VIPER-wt-explorer`), on top of Tasks 04, 05 and 11.

### What was built

- **Editability policy** next to the exposure policy (`backend/app/services/explorer/policy.py`): default-deny
  `TableWrites` (update / insert / delete, each `None` or a French reason) per table and `ColumnPolicy.edit`
  (editable / set at creation / read-only + reason) per column, combined in `metadata.py` with structural rules
  (generated keys, `created_at`/`updated_at`, JSON/array values, masked columns, references to unexposed tables are
  read-only; required-on-insert computed). The table metadata API now returns `updatable`, `insertable`,
  `read_only_reason`, `required_on_insert` per column and `update_refused`, `insert_refused`, `delete_refused`,
  `bulk_delete`, `version_column`, `label_columns` per table. Policy table: `doc/features/database-explorer.md`.
  Decisions: prospects not created from the explorer, opposition columns read-only, provenance only completable
  (context, notes), import/history/audit tables read-only; `company_activity_categories` insert/delete written through
  the audited `Company.activity_categories` (audited as `company.updated`) — a test forbids any other unaudited table.
- **Typed staged change set** (`changes.py`, `writes.py`, route `POST /api/explorer/tables/{table}/changes` in the new
  router `explorer_writes.py` with `audit_source(DATABASE_EXPLORER)`): updates by key + row version, inserts,
  deletes; all errors collected per change/column (type, length, enum, NOT NULL, required columns, read-only, unknown
  column, duplicate row); rows locked and checked (existence, **optimistic version = `updated_at`** → 409 conflict,
  FK targets exist, do-not-contact deletion, second tracking row, existing link, detaching a prospect); application
  through the ORM in the request transaction (deletes → updates → inserts, one savepoint each, failed changes retried
  after the others so a primary-email swap works in any order); database refusals mapped to French messages per
  constraint (`CONSTRAINT_MESSAGES`, test-enforced complete) with the column to highlight; all or nothing.
  Domain rules delegated: `company_id` → `prospects.change_company` (I-13), contact tracking → `save_contact_tracking`.
- **Delete diagnostics** (`deletion.py`, `GET …/delete-check?key=…`): RESTRICT blockers, CASCADE (recursive) and
  SET NULL effects with counts, do-not-contact blocker, bulk refusal where deletions cascade, missing rows.
- **Frontend**: pure staged-changes store (`staging.ts`) and editing rules (`editing.ts`); inline typed editors
  (`CellEditor.tsx`: text / multi-line text, number, datetime-local, date, enum & boolean selects, FK picker searching
  the target table by its label columns, `NULL` button, loading of truncated values; Enter/Tab/Esc/blur semantics);
  double-click / Enter / F2 / typing start editing; dirty cells (amber tint + pencil marker + original value tooltip),
  new rows (+ marker), rows to delete (struck through + trash marker), server errors on cells/row headers; pending bar
  (`N modifications en attente`, breakdown, `Voir le détail` review drawer with per-cell/per-row undo, `Annuler`,
  `Enregistrer`); `Ajouter une ligne` (opens the first required column); deletion via context menu or row checkboxes
  (bulk tables only) with the diagnostics dialog; read-only reasons (cell tooltip, F2 announcement, disabled menu item,
  header lock, `Lecture seule` badge); context menu `Modifier la cellule`, `Mettre à NULL`, `Annuler la modification`,
  `Supprimer la ligne…`, `Annuler la suppression`; dirty-navigation guard (router blocker for table switch, FK hops,
  Back, other pages; `beforeunload` for reload/close). Grid scroll padding keeps edited cells clear of pinned columns.

### Key files

Backend: `app/services/explorer/{policy,metadata,query,changes,writes,deletion,__init__}.py`,
`app/api/routes/{explorer,explorer_writes}.py`, `app/api/router.py`, `pyproject.toml` (ruff allows `’`);
tests `tests/test_explorer_writes.py` (28 tests, 35 cases), `tests/test_explorer_editability.py` (13), updated
`test_explorer_metadata.py` / `test_explorer_reads.py` (metadata contract grew; the "no write method" test now pins
the single POST endpoint). Frontend: `src/api/{client,explorer}.ts`, `src/database/{staging,editing,CellEditor,
PendingChanges,DeleteRowsDialog,UnsavedChangesGuard,ExplorerGrid,GridHeader,TableWorkspace,cellMenu,DatabasePage}`,
`database.css`, `src/ui/{Menu.tsx,menu.css,icons.tsx}`; tests `staging.test.ts`, `editing.test.ts`,
`TableEditing.test.tsx`, updated `cellMenu.test.ts`, `DatabasePage.test.tsx`, `client.test.ts`, fixtures;
E2E `e2e/database-edit.spec.ts` (+ `database.spec.ts`: the value viewer now opens with the expand button, since
double-click edits editable cells). Docs: `doc/features/database-explorer.md`, ADR-0008, ADR-0005 (amended line),
decision log I-60 … I-66, `architecture/{overview,audit-and-provenance,security-and-privacy}.md`,
`features/interface-spec.md`, runbook.

### Tests run

`python scripts/verify.py --e2e` with `VIPER_E2E_DATABASE_URL=…/viper_wt_e2e VIPER_E2E_WEB_PORT=5184
VIPER_E2E_API_PORT=8143` (backend `.env` on `viper_wt` / `viper_wt_test`): privacy guard, ruff, ruff format, mypy
(101 files), pytest, eslint, tsc, vitest, vite build, Playwright — results in the final message to the orchestrator.

### Deviations / decisions

See decision log I-60 … I-66 and ADR-0008 (row-level optimistic concurrency with `updated_at`; policy choices;
link-table writes through the company; service delegation; delete diagnostics and bulk rule; typographic apostrophe
allowed by ruff). Double-click on an editable cell now edits (it still opens the value viewer on read-only cells;
the expand button always does).

### Open points

- Rows deleted by `ON DELETE CASCADE` are not audited one by one (ADR-0006 limit), stated in the dialog.
- Row-level versions refuse a save when any column of the row changed meanwhile (conservative).
- No value normalization in the explorer (e.g. capital letters in an e-mail are refused by the CHECK with an
  explanatory message rather than lower-cased); no multi-cell paste / fill-down; JSON/array values read-only.
- Creating prospects from the explorer is refused until Prospection (Tasks 06/15) records provenance on creation;
  the policy entry can be relaxed then.
