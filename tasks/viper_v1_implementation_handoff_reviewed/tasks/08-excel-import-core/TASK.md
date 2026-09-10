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
