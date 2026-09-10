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
