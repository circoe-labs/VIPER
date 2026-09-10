# Task 08 — Implement deterministic Excel/CSV parser, mapping and diagnostics

## Goal
Build the side-effect-free import engine that understands legacy workbook structure and produces a typed preview model.

## Context
See `../../docs/excel-mapping.md` and `legacy-data-profile.md`. Real workbook is local-only; repository fixtures must be synthetic.

## Coding Skill Requirement
Before editing code, load and follow `/caveman` and `/coding-guideline` from `~/ai/skills/`.

## Scope
### In Scope
- XLSX/CSV parse.
- Sheet recognition and explicit skip notices.
- Column mapping.
- Normalization diagnostics for civility/category/role/referent/week/mode/contact stage.
- Exact duplicate and likely-match candidate detection.
- Legacy metadata capture.
- Contactability conflict detection.
- Typed ImportPreview with warning/error codes.

### Out of Scope
- No DB writes.
- No preview UI.
- No external enrichment.
- No silent role/taxonomy creation.

## Dependencies
Tasks 03, 05, 06; Settings data from Task 06 available for role/category matching.

## Implementation Steps
1. Implement parser adapters.
2. Implement mapping/normalization rules.
3. Implement anomaly codes.
4. Implement duplicate candidate logic.
5. Preserve unknown row metadata.
6. Create synthetic fixtures.
7. Validate privately against real workbook without logging rows.

## Files Likely Touched
Import parser/adapters, preview types, normalization rules, synthetic fixtures, tests.

## Architecture Constraints
Pure/deterministic parser. No DB side effects. Never infer S37/S39 year. Never map garbage to Referent. Never reactivate blocked contact in merge proposal.

## Testing Requirements
Unit tests for all known anomalies; private compatibility smoke on real workbook; no PII in snapshots/logs.

## Acceptance Criteria
- Real workbook parses to structured preview privately.
- All known anomalies surfaced.
- Unknown data preserved.
- Parser safe to run without DB.

## Documentation Updates
Update mapping docs with any new legacy behavior discovered.

## Handoff Notes
Do not commit the real workbook or real row snapshots.

## Implementation report

Branch `task-08-import-core` (worktree `C:\Projects\VIPER-wt-import`), 2026-09-10.

### What was built

- **Pure import engine** `backend/app/services/imports/` ([ADR-0007](../../../../doc/adr/0007-import-engine.md)):
  `build_preview(ImportFile(filename, bytes), ImportReferenceData, ImportMapping | None, *, limits)` →
  typed, JSON-serializable, deterministic `ImportPreview`. No database, clock, randomness or network.
  - `workbook.py` — XLSX (openpyxl 3.1.5 read-only, cached values, merged ranges via a stdlib XML scan, vertical
    merges copied down) and CSV (UTF-8/BOM, UTF-16 BOM, Windows-1252 fallback with notice; `;`/`,`/tab sniffing)
    adapters; limits as settings (`VIPER_IMPORT_MAX_FILE_MB` 10, `VIPER_IMPORT_MAX_ROWS` 5000,
    `VIPER_IMPORT_MAX_COLUMNS` 100, unzipped ≤ 10 × file limit); encrypted/legacy `.xls`/corrupt files rejected
    with French messages, never echoing content.
  - `fields.py` — the only place knowing legacy headers (`LEGACY_LAYOUT`, 23 named columns + aliases);
    `layout.py` — prospect sheet by header fingerprint, `sheet.skipped` for every other sheet, folded header
    matching, repeated `A contacter` by position, unknown/unnamed/duplicate/missing column notices, user overrides
    (`ImportMapping`: sheet, header row, column → field or raw).
  - `normalize.py` / `matching.py` — civility, names (particles), emails, phones (French formats, type, restored
    zero), planned-contact week (never a guessed year; `retraité` → inactive suggestion), stage collapse (most
    advanced wins, conflicts flagged), address → establishment, categories (never split on `&`), role/category/
    segment suggestions (never created), referents (markers, email-like text, notes never become referents).
  - `rows.py` — per-row proposals (company, establishment, prospect, emails, phones, tracking, referent) and
    **lossless legacy metadata** (`{column, header, value, reason}`; every non-empty cell reported mapped and/or
    preserved). `dedup.py` — in-file and existing duplicate candidates with reasons/confidence, company key (legal
    forms), company variants and conflicting values, **do-not-contact blocking** (error; proposals never carry
    contactability). `diagnostics.py` — 71 codes with fixed severity and French message (values never in
    messages). `preview.py` — summary (sheets, mapping, counts per code/severity/status, duplicate-email groups).
  - `reference.py` + `reference_loader.py` / `app/repositories/import_reference.py` — plain snapshot and its
    SELECT-only loader from the database.
- **Synthetic fixtures** generated in memory (`backend/tests/fixtures/synthetic/legacy_workbook.py`), one row per
  legacy compatibility case; no spreadsheet committed.
- **Private smoke** `backend/tests/test_import_private_workbook.py` (marker `private`, skipped without
  `VIPER_PRIVATE_WORKBOOK`), aggregate output only.

### Files

- New: `backend/app/services/imports/{__init__,text,fields,diagnostics,workbook,layout,normalize,models,reference,
  matching,rows,dedup,preview,reference_loader}.py`, `backend/app/repositories/import_reference.py`,
  `backend/tests/fixtures/synthetic/legacy_workbook.py`, `backend/tests/test_import_{workbook,layout,normalize,
  matching,dedup,preview,reference_loader,private_workbook}.py`, `doc/adr/0007-import-engine.md`.
- Changed: `backend/requirements.txt` (`openpyxl==3.1.5`), `backend/requirements-dev.txt`
  (`types-openpyxl==3.1.5.20260827`), `backend/app/core/config.py` + `.env.example` (import limits),
  `backend/pyproject.toml` (`private` marker), `doc/features/excel-import-export.md` (implemented mapping table,
  normalization rules, full diagnostic catalogue, dedup rules, limits, JSON contract),
  `doc/legacy/legacy-data-profile.md` (new structural findings), `doc/product/decision-log.md` (I-50 … I-59),
  `doc/architecture/overview.md`, `doc/process/testing-strategy.md`, `doc/process/runbook-local-dev.md`.

### Tests run

- `python scripts/verify.py --e2e` (with `VIPER_E2E_DATABASE_URL=…/viper_wt2_e2e`, `VIPER_E2E_WEB_PORT=5186`,
  `VIPER_E2E_API_PORT=8146`) → **All checks passed**: privacy guard OK; ruff, format, mypy (119 files) clean; pytest **459 passed, 1 skipped**
  (the private smoke); eslint, tsc OK; vitest **274 passed** (19 files); vite build OK; Playwright **19 passed**.
- New backend tests (215, 1 of them private): 24 adapters, 25 layout, 90 normalizers, 41 matching, 7 dedup, 24 end-to-end (every
  compatibility case, determinism with a reordered reference, sockets disabled, no DB import in engine modules,
  JSON round trip, CSV, merged cells, overrides, catalogue documented, seeded property test over 300 generated rows
  / > 3000 cells), 3 reference loader (real test database, SELECT-only).
- Private smoke, run once locally with `VIPER_PRIVATE_WORKBOOK` pointing at the main checkout's workbook and an
  empty reference snapshot (no Settings data yet) → **1 passed**. Aggregate output (counts only):

  ```
  rows=339 empty=3  rows_by_status: ok 3, warning 325, error 11  severities: error 11, warning 830, info 266
  activity.inactive_suggested 1 · category.invalid 3 · category.unmatched 236 · civility.invalid 3
  column.legacy_preserved 2 · column.unnamed 1 · company.field_conflict 18 · company.missing 6
  company.variant_in_file 16 · duplicate.email_in_file 6 · duplicate.person_in_file 8 · email.invalid 2
  planned_contact.not_a_week 1 · planned_contact.week_without_year 100 · prospect.missing_name 11
  prospect.partial_name 20 · referent.email_like 4 · referent.marker 123 · referent.note 2 · referent.unknown 99
  role.unmatched 198 · sheet.skipped 1 · value.zero_placeholder 246 · duplicate_email_groups 3
  ```

  Asserted: prospect sheet `Base client `, `actualité` skipped with notice, header row 1, 339 data rows, 3 blank
  rows, 24 columns (23 mapped, W by position, X unnamed), all expected anomaly codes, 3 duplicate-email groups, no
  unaccounted cell, identical JSON on a second run.

### Deviations / decisions

- Decisions I-50 … I-59 (placement and purity, file handling and limits, sheet/column rules, legacy metadata
  format and `0` placeholder, civility/name rules, week handling, stage precedence and conflicts, channel rules and
  primary selection, category/role/referent matching, dedup confidences and do-not-contact blocking).
- The engine lives in `app/services/imports/` rather than a new `app/adapters/` layer (explorer precedent I-41);
  legacy names are confined to `fields.py`.
- `Mode de contact` and the second `A contacter` are preserved raw only (opaque), as the contract requires; no
  segment mapping.

### Open points / risks

- With no internal referents or activity categories in the database yet (Task 06), the real workbook yields 99
  `referent.unknown` and 236 `category.unmatched`: the historical category labels (`N. Label & Label`) will need a
  mapping decision in Task 09 (map to seeded categories or create them in Settings).
- Task 09 must: call `load_reference_data` + `build_preview`, require a year for `requires_year` weeks, confirm
  suggestions flagged `requires_confirmation`, only skip or attach rows `blocked_by_do_not_contact`, store
  `legacy_metadata` values as given, and never write contactability on merge.
- Dedup loads every prospect and email; fine at V1 scale, revisit with indexed lookups if the base grows a lot.
- Heuristics (name-like referents, note words, webmail list, similarity thresholds) are documented and tested but
  will need tuning on real Settings data.
