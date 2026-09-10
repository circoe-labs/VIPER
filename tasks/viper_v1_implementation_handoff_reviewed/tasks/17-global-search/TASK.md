# Task 17 — Implement global VIPER search

## Goal
Provide fast cross-entity lookup from any page.

## Context
This was a strong accepted UX recommendation; it reduces friction for a database-maintenance tool.

## Coding Skill Requirement
Before editing code, load and follow `/caveman` and `/coding-guideline` from `~/ai/skills/`.

## Scope
### In Scope
- Search prospects by name/email/phone.
- Search companies by display/legal name, SIREN, site/domain.
- Optionally establishments by SIRET.
- Keyboard navigation.
- Open Prospect/Company/Database context.
- Efficient debounced backend query.

### Out of Scope
- No external/web search.
- No search platform overbuild.

## Dependencies
Tasks 03, 07, 14-15.

## Implementation Steps
1. Define result contract.
2. Add indexes/query service.
3. Add shell search UI.
4. Add keyboard navigation.
5. Test.

## Files Likely Touched
Search service, shell component, tests.

## Architecture Constraints
Parameterized query; result contract exposes typed entity IDs/context, not raw DB rows.

## Testing Requirements
Name/company/email/SIREN/SIRET/domain search, keyboard navigation, no-result/error, performance.

## Acceptance Criteria
- Common entities reachable quickly.
- Search remains compact and safe.

## Documentation Updates
Document indexed fields.

## Handoff Notes
If schedule is extremely constrained, orchestrator may explicitly defer this task; do not silently omit it.
