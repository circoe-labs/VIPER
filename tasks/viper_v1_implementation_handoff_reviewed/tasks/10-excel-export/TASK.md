# Task 10 — Implement normalized Excel export

## Goal
Generate a clean Excel workbook from current DB state, reflecting edits and correcting historical semantic mistakes.

## Context
Exact final column ordering is centralized/configurable. Export must preserve useful legacy metadata and handle aliases deterministically.

## Coding Skill Requirement
Before editing code, load and follow `/caveman` and `/coding-guideline` from `~/ai/skills/`.

## Scope
### In Scope
- Core company/prospect/tracking/contactability fields.
- Separate Referent, activity status and verification date.
- Planned-contact date (+ optional derived week).
- Consolidated tracking status and response/appointment outcomes.
- Primary email/phone compatibility columns.
- Deterministic alias export policy.
- Legacy metadata preservation.
- Download action.

### Out of Scope
- No recreation of `xxx/?` Referent misuse.
- No five legacy stage booleans unless explicit compatibility mode later.
- No live synchronization.

## Dependencies
Tasks 03, 07, 09.

## Implementation Steps
1. Define centralized column spec.
2. Resolve/document alias export shape.
3. Implement DB projection.
4. Generate readable XLSX.
5. Add round-trip tests after manual edits.
6. Verify contactability and legacy metadata export.

## Files Likely Touched
Export service/adapter, column spec, endpoint/action, tests.

## Architecture Constraints
Export from domain state, not cached import rows. Correct types/dates. Column order change does not require migration.

## Testing Requirements
Workbook opens; import→edit→export; Referent split; alias handling; legacy metadata; do-not-contact; formula-free deterministic output where possible.

## Acceptance Criteria
- Usable normalized workbook downloads.
- Edits reflected.
- No semantic regression.
- Useful imported data not silently lost.

## Documentation Updates
Document shipped export columns/order and alias strategy.

## Handoff Notes
The user’s priority ordering should guide the default, but exact normalized order can be adjusted centrally.

## Implementation report

Branch `task-10-export` (worktree `C:\Projects\VIPER-wt-import`), based on `claude` @ b214be8, `claude` @ 3998d0d
merged in before the final verification.

### What was built

- **Centralized specification** `backend/app/services/exports/spec.py`: seven sheets in order, each column with its
  French header, value getter, cell kind (`TEXT`, `CODE`, `DATE`, `DATETIME`, `INTEGER`, `RAW`) and width; French
  labels of every enum. The only module knowing the layout — reordering or renaming a column is an edit there, no
  migration. Default `Prospects` order follows the grill priorities (Référent → planning/company → classification →
  identity/role/activity/verification/primary channels → company context → tracking/opposition → provenance → ids).
- **Projection** `projection.py` + `app/repositories/exports.py`: one read of every exported entity (SELECTs only),
  references resolved into records; deterministic Python ordering (folded texts, id tie-breaker). Values come from the
  domain; import row metadata only feeds the `Données d'origine` sheet.
- **Writer** `workbook.py` (openpyxl write-only): header styling, frozen header, autofilter, widths; real dates on the
  Europe/Paris calendar; Text-formatted string cells for phones/SIREN/SIRET/postal codes/ids; every text forced to a
  string cell + `quotePrefix` for formula-like texts (rule shared with the explorer CSV in `app/core/spreadsheet.py`);
  deterministic bytes (generation date as input, stamped on the document properties and every zip entry).
- **Service + endpoint**: `app/services/excel_export.py` (`build_workbook`, `export_workbook` with the new audit action
  `export.generated`, counts only) and `GET /api/exports/workbook` (protected, `VIPER_export_YYYY-MM-DD.xlsx`,
  `Cache-Control: no-store`, nothing stored). No query parameter: Task 14 can add Prospection filters on this path.
- **Frontend**: `apiDownload` in `src/api/client.ts`, `src/api/exports.ts`, reusable
  `src/exports/ExportWorkbookButton.tsx` (progress « Export en cours… », French error and retry), placed in the
  `/prospection/companies` and `/prospection/import` headers.
- **Docs**: ADR-0013; `doc/features/excel-import-export.md` (*Export — as implemented*: download, sheets, full default
  column order, alias and legacy-metadata policies, cell types and safety, round-trip meaning, private check);
  decision log I-83 … I-89 (+ deferred list); open questions #6 narrowed, #7 resolved; `audit-and-provenance.md`,
  `security-and-privacy.md`, `overview.md`, `testing-strategy.md`, runbook.

### Files

Backend: `app/services/exports/{__init__,spec,projection,workbook}.py`, `app/services/excel_export.py`,
`app/repositories/exports.py`, `app/api/routes/exports.py`, `app/core/spreadsheet.py` (new);
`app/api/router.py`, `app/services/audit.py` (`EXPORT_GENERATED`), `app/services/explorer/reads.py` (uses the shared
formula rule). Tests: `tests/test_excel_export.py`. Frontend: `src/api/client.ts`, `src/api/client.test.ts`,
`src/api/exports.ts`, `src/exports/ExportWorkbookButton.tsx`, `ExportWorkbookButton.test.tsx`, `exports.css`,
`src/companies/CompaniesPage.tsx`, `src/imports/ImportPage.tsx`, `e2e/export.spec.ts`.

### Tests

- `python scripts/verify.py --e2e` with `VIPER_E2E_DATABASE_URL=…/viper_wt2_e2e`, `VIPER_E2E_WEB_PORT=5186`,
  `VIPER_E2E_API_PORT=8146`, after merging `claude` @ 3998d0d → **All checks passed**: privacy guard OK (430 tracked
  files), ruff/format/mypy (159 files) clean, pytest **755 passed, 2 skipped** (the private checks), eslint/tsc OK,
  vitest **471 passed** (34 files), vite build OK, Playwright **52 passed**.
- New: 10 backend tests (`tests/test_excel_export.py`: layout == spec, types and leading zeros, ordering and companies
  without prospects, empty company/tracking, round trip import → service + explorer edits → API download, byte
  determinism, formula guard, audited attachment, 401, 3 000 prospects ≈ 10 s locally with a 45 s bound); 7 frontend
  (`ExportWorkbookButton.test.tsx` ×5, `client.test.ts` ×2); 1 Playwright (`e2e/export.spec.ts`: download, file name,
  zip signature, sheet names and the test's own company read from the archive with Node's zlib).
- `src/companies/CompanyEditor.test.tsx` (Task 07) was flaky on `claude` itself: « manages establishments » takes
  ≈ 4.9 s against Vitest's 5 s default and, once over, keeps typing into the following tests (1–3 cascading failures
  per full run, reproduced with this branch's changes stashed). The suite now has a 15 s timeout; no assertion changed.
- Private (manual, not CI): the real workbook committed into `viper_wt2` with the default decisions (11 nameless rows
  excluded), exported in memory, aggregates only, database reset afterwards (0 rows left): commit 328 imported / 11
  excluded, 324 prospects, 247 companies, 233 e-mails, 213 phones; export ≈ 0.2 MB — `Prospects` 324 × 38,
  `Entreprises` 247 × 19, `Établissements` 0 × 12, `E-mails` 233 × 11, `Téléphones` 213 × 12, `Provenance` 328 × 11,
  `Données d'origine` 1 145 × 12 = 1 145 legacy entries stored in 328 row metadata; headers equal to the
  specification; 0 non-empty `Référent` (no referent recognised, markers kept out; 0 not an internal referent);
  0 planned dates / weeks (weeks without year); 233 primary e-mails, 168 primary phones; 0 formula cells, 1
  quote-prefixed text. The exported file was never written to disk.

### Deviations / decisions

- I-83 … I-89 (architecture, default order, semantics, alias shape, seven lossless sheets, typed/formula-free/
  deterministic XLSX, delivery and audit). ADR-0013.
- Formula guard: XLSX uses typed string cells + `quotePrefix` rather than the CSV's leading apostrophe (which would
  become part of the visible value); detection rule identical and now shared.
- Employment verification has no domain service yet (Prospect editor = Task 15); the round-trip test verifies
  employment through the Database Explorer's audited change-set endpoint, the manual path of V1 today.
- The `Prospects` sheet is not a re-import format (headers close to the legacy ones where the meaning is identical,
  but no round trip back through the import is promised; no live synchronization).

### Open points / risks

- Cost is linear and dominated by openpyxl's pure-Python XML serializer: ≈ 10 s for 3 000 prospects with aliases and
  legacy values (≈ 190 000 cells) locally; < 1 s for the real 339-row workbook. `lxml` would speed it up if needed.
- The export reads in one transaction at the default isolation (READ COMMITTED): a concurrent write during a long
  export could appear in some sheets and not others. Single pilot user: accepted.
- Task 14 should reuse `ExportWorkbookButton` in the Prospection header and, if it wants filtered exports, add query
  parameters to the same endpoint and a row filter in `projection.load_export_data`.
- Open question #6 stays open only as "the operator may want another order" — one module to edit.

