# Task 07 — Implement lightweight Company and Establishment editor

## Goal
Allow manual creation/update of the company context the user explicitly wants to feed outside raw Database editing.

## Context
Company is documentary context, not a CRM dossier. Prospect editor should link to this dedicated lightweight company editor.

## Coding Skill Requirement
Before editing code, load and follow `/caveman` and `/coding-guideline` from `~/ai/skills/`.

## Scope
### In Scope
- Create/edit company name/legal name/SIREN/site/domain/size.
- One commercial segment, multiple categories.
- Manage establishments with SIRET/address/kind/primary.
- Edit project/reference/approach metadata.
- Show associated prospect count/list for navigation.
- Audit changes.

### Out of Scope
- No opportunities/projects/deals/tasks.
- No prospect contact tracking here.

## Dependencies
Tasks 03, 05, 06.

## Implementation Steps
1. Define form/view model.
2. Implement create/edit services.
3. Build company drawer/page.
4. Add establishment repeater/editor.
5. Add taxonomy selectors.
6. Add associated-prospect navigation.
7. Audit/test.

## Files Likely Touched
Company/establishment UI, services, validation, tests.

## Architecture Constraints
No duplicated company fields on Prospect. SIREN/SIRET uniqueness errors are understandable. Company domain normalized.

## Testing Requirements
Create/edit, category multi-select, segment single, establishment CRUD, SIREN/SIRET conflict, audit, keyboard form behavior.

## Acceptance Criteria
- Company table can be fed manually without Database Explorer.
- Establishments remain company-only.
- Editor stays lightweight.

## Documentation Updates
Document company field semantics.

## Handoff Notes
Accessible from Prospect editor/global search later.
