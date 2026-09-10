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
