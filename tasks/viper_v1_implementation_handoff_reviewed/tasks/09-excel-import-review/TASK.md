# Task 09 — Implement import preview, correction, dedup review and transactional commit UI

## Goal
Turn ImportPreview into the user-facing drag/drop workflow with explicit corrections/exclusions and safe normalized DB commit.

## Context
This is the core V1 Excel feed workflow. Separate it from parser logic for testability.

## Coding Skill Requirement
Before editing code, load and follow `/caveman` and `/coding-guideline` from `~/ai/skills/`.

## Scope
### In Scope
- Drag/drop upload.
- Preview counts/diagnostics.
- Row edit/exclude.
- Map unresolved role/category/referent/week values.
- Duplicate candidate choose existing/create/skip behavior.
- Explicit commit.
- Import batch/provenance/audit creation.
- Preserve legacy metadata.
- Prevent do-not-contact reactivation.

### Out of Scope
- No automatic web enrichment.
- No live Excel sync.
- No silent corrections.

## Dependencies
Tasks 05-08.

## Implementation Steps
1. Build upload + preview UI.
2. Build diagnostics/filtering.
3. Add correction/mapping controls.
4. Add duplicate resolution.
5. Implement transactional commit service.
6. Emit provenance/audit.
7. Test rollback and contactability protection.

## Files Likely Touched
Import route/components, commit service, dedup resolution UI, tests.

## Architecture Constraints
DB write only after explicit confirmation. Commit is transactional. User decision is recorded for ambiguous mappings.

## Testing Requirements
Preview interaction, correction/exclusion, duplicate resolution, rollback, provenance/audit, blocked-contact merge prevention.

## Acceptance Criteria
- User sees errors/duplicates before confirmation.
- Confirmed import creates normalized entities.
- No silent data loss/reactivation.
- Import source is traceable.

## Documentation Updates
Document final import workflow/diagnostic codes.

## Handoff Notes
Import action will be linked from Prospection.

## Implementation report

### What was built

- **Stateless review, digest-bound commit** (ADR-0012): the browser keeps the file; `POST /api/imports/preview`
  (multipart `file` + optional `options`: mapping, per-cell corrections) returns the review — the engine preview,
  values grouped by raw value (roles by job title, category tokens, referents, invalid civilities, weeks without year,
  company keys) with conservative defaults, per-row default resolutions, named duplicate candidates — and a SHA-256
  digest of the preview. `POST /api/imports/commit` (file + `decisions`) re-runs the engine on a fresh snapshot and
  refuses a changed file (`file_changed`) or preview (`preview_outdated`); re-importing a committed fingerprint needs
  `acknowledge_reimport`. `GET /api/imports`, `GET /api/imports/{id}`: history, metadata only. Bodies are parsed after
  the session/CSRF guard and a `Content-Length` bound.
- **Typed decisions** (`app/services/imports/decisions.py`, pydantic, extra fields forbidden): corrections (fed back
  through the engine, original kept as `<field>_original`), role none/existing/create, category
  ignore/existing/create/segment, referent ignore/existing, civility, batch/per-week year, company create/link, row
  create/attach/attach_row/exclude, inactive confirmation, legal basis (required) and source reference.
- **Pure plan** (`review.py`): groups, defaults, validation (`invalid_decisions` codes) — errors must be resolved or
  the row excluded; warnings never block; a do-not-contact row can only be excluded or attached to that prospect.
- **Transactional commit** (`app/services/import_commit.py`): one savepoint — Settings values the user chose to
  create (by the user) → batch → inside `importing` (import actor on behalf of the user): companies (+ establishment),
  prospects (`create_prospect`, channels imported/unverified, employment never verified) or fill-empty merges
  (`add_channels`, `change_company` only when empty, `companies.complete_company` for linked companies) → contact
  tracking via `save_contact_tracking` (never for a do-not-contact prospect, never changing an existing stage) →
  `excel_import` source + `import_row_metadata` per imported row → batch committed with counts. Any failure rolls
  the savepoint back and records a `failed` batch in the request transaction. Values not applied stay raw in the row
  metadata (lossless).
- **Migration 0006**: `import_batches.legal_basis_or_collection_context`, `import_batches.source_reference`.
- **Engine**: corrections parameter + two diagnostic codes; `LegacyReason.CORRECTED`, `SourceCell.corrected`;
  **bug fix**: structured addresses silently lost their street line (`EstablishmentProposal` now forbids unknown
  fields).
- **Frontend** `/prospection/import` (`frontend/src/imports/`): state machine (file → analysis → sheet confirmation
  with skipped sheets → review → commit dialog → result), summary tiles and remark chips as filters, *À résoudre*
  panel with grouped controls (Settings pickers without inline creation; explicit « Créer » deferred to the commit),
  row table (search, filters, pagination, detail with remarks, what will be imported, duplicate choice, correction
  form, preserved values), commit summary with provenance fields and re-import acknowledgement, result and history.
  « Importer Excel » entries on the Prospection placeholder and the Entreprises header.

### Files

- Backend new: `app/services/imports/{decisions,review}.py`, `app/services/import_commit.py`,
  `app/api/routes/imports.py`, `migrations/versions/0006_import_batch_provenance.py`, `tests/import_support.py`,
  `tests/test_import_commit.py`, `tests/test_imports_api.py`, `tests/test_import_private_commit.py`.
- Backend changed: `app/services/imports/{fields,diagnostics,models,rows,preview}.py`, `app/services/{prospects,
  companies,import_batches}.py`, `app/repositories/provenance.py`, `app/models/imports.py`, `app/api/router.py`,
  `requirements.txt` (`python-multipart==0.0.32`), `tests/test_import_preview.py`, `tests/test_companies.py`.
- Frontend new: `src/api/imports.ts`, `src/imports/*` (page, steps, panels, plan, flow, messages, CSS, tests),
  `src/test/importFixtures.ts`, `e2e/import.spec.ts`. Changed: `src/api/client.ts` (+test, FormData), `src/routes.tsx`,
  `src/companies/CompaniesPage.tsx`, `src/shell/shell.css`, `src/ui/icons.tsx`, `e2e/database-sql.spec.ts` (race fix).
- Docs: ADR-0012, `doc/features/excel-import-export.md` (workflow, decisions, merge rules, commit semantics, API,
  private run), decision log I-72 … I-79, `data-model.md`, `audit-and-provenance.md`, `security-and-privacy.md`,
  `overview.md`, `company-editor.md`, `testing-strategy.md`, runbook.

### Tests

- `python scripts/verify.py --e2e` with `VIPER_E2E_DATABASE_URL=…/viper_wt2_e2e`, `VIPER_E2E_WEB_PORT=5186`,
  `VIPER_E2E_API_PORT=8146` → **All checks passed**: privacy guard OK (397 tracked files), ruff/format/mypy (150
  files) clean, pytest **745 passed, 2 skipped** (the two private checks), eslint/tsc OK, vitest **456 passed** (33
  files), vite build OK, Playwright **51 passed**.
- New backend tests: 25 service tests (`test_import_commit.py`), 18 API tests (`test_imports_api.py`), 1
  `complete_company` test, 1 engine assertion (address street line); frontend 22 (plan, flow, page); Playwright 3
  (flow + dark/light screenshots).
- Private (manual, not CI): preview + commit of the real workbook, default decisions, the 11 rows without a name
  excluded, aggregates only — on the worktree dev database (reset to `base` afterwards) and again through
  `test_import_private_commit.py` inside the rolled-back test transaction, same results: 339 rows (ok 3 / warning 325
  / error 11); groups — roles 117 (108 unknown, 8 suggested, 1 exact vs the seeded roles), categories 12 (unknown),
  referents 12 (3 unknown, 3 markers, 2 notes, 4 e-mail-like), 2 weeks, 1 civility, 253 company keys; defaults 335
  create + 4 merges into an earlier row; commit → 328 imported, 11 excluded, 324 prospects, 247 companies, 233
  e-mails, 213 phones, 0 contact tracking, 328 sources and row metadata; invariants OK (no opposition touched, every
  row imported or excluded, row metadata = imported rows, one source per imported row, channels imported/unverified,
  no employment verified). Preview 0.34 s, commit 7.7 s.

### Deviations / decisions

- I-72 … I-79. Referents are not created from the import (map or create in Paramètres, then « Relancer l'analyse »);
  roles and categories to create are created at commit time by the user through the Settings service.
- Migration 0006 (two nullable columns on `import_batches`) — to chain correctly if another branch adds a migration.
- New dependency `python-multipart` (standard FastAPI multipart parser).
- `e2e/database-sql.spec.ts`: its "nothing changes" check compared the global company count before/after while other
  specs create companies in parallel (I-80); it now counts the synthetic dataset's own companies (zero-padded SIRENs).

### Open points / risks

- Commit cost is linear with one flush per step (≈ 7.7 s for 339 rows locally); batch it if files grow a lot.
- The review JSON carries every source cell (≈ a few hundred KB for the real file); fine at V1 scale.
- Any database change between review and commit (even an unrelated new company that becomes a candidate) requires a
  re-analysis; decisions survive it.
- Task 14 should place the final « Importer » button and may filter Prospection on a batch (the result screen links to
  the batch's sources and rows in the Database Explorer meanwhile).
