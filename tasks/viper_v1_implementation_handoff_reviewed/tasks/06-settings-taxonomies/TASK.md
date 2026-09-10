# Task 06 — Implement Settings taxonomies and internal referents

## Goal
Create safe management UI/API for Roles, Activity Categories, Commercial Segments and Circoe Internal Referents.

## Context
Taxonomies must be extensible from forms without code changes. Referents are business records, not login users.

## Coding Skill Requirement
Before editing code, load and follow `/caveman` and `/coding-guideline` from `~/ai/skills/`.

## Scope
### In Scope
- List/search/add/rename/deactivate Roles.
- Same for Activity Categories and Commercial Segments.
- Add/edit/deactivate Internal Referents.
- Protect in-use values from destructive deletion.
- Reusable selectors/create-new API.

### Out of Scope
- No permissions matrix.
- No agent/mail settings.

## Dependencies
Tasks 03-05.

## Implementation Steps
1. CRUD/deactivate services.
2. Settings sections.
3. Searchable selectors/create-new interaction.
4. Duplicate/in-use diagnostics.
5. Audit mutations.
6. Tests.

## Files Likely Touched
Settings routes/components, taxonomy/referent services, shared selectors, tests.

## Architecture Constraints
Stable IDs survive rename. Deactivation does not orphan references. All mutations audited.

## Testing Requirements
Add/rename/deactivate, duplicate prevention, in-use protection, audit event.

## Acceptance Criteria
- User can extend taxonomies.
- Referents maintained separately from auth.
- Existing links survive rename/deactivation.

## Documentation Updates
Update taxonomy behavior docs.

## Handoff Notes
Selectors feed Company and Prospect editors.
