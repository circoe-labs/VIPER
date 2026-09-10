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
