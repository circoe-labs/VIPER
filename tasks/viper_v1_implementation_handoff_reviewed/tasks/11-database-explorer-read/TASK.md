# Task 11 — Implement Database Explorer read/metadata/grid foundation

## Goal
Build the DBeaver-inspired read-only exploration foundation before adding mutation and SQL complexity.

## Context
Database Explorer is a core user feature. It must use most screen space and remain pleasant with many columns/rows.

## Coding Skill Requirement
Before editing code, load and follow `/caveman` and `/coding-guideline` from `~/ai/skills/`.

## Scope
### In Scope
- Left table rail/search/counts.
- Metadata endpoint (columns/types/nullability/PK/FK).
- Paginated/virtualized grid.
- Sticky headers and horizontal scroll.
- Search/filter/multi-sort.
- Hide/show/reorder/resize/pin columns with local persistence.
- Long-value viewer.
- Copy cell/row/filter-by-value.
- FK navigation.
- Refresh/filtered export.

### Out of Scope
- No writes yet.
- No SQL console yet.
- No schema designer.

## Dependencies
Tasks 02-03.

## Implementation Steps
1. Metadata service.
2. Safe parameterized table reader/filter AST.
3. Rail + grid.
4. Column state interactions.
5. Value viewer/context actions.
6. FK navigation/refresh/export.
7. Performance tests.

## Files Likely Touched
Database page/components, explorer read service, query/filter types, tests.

## Architecture Constraints
Never concatenate untrusted filters into SQL. Explorer adapter is separate from business services. Large datasets use server paging/virtualization.

## Testing Requirements
Injection-safe filters, paging, sort/filter combinations, column state, long values, FK navigation, large synthetic dataset performance.

## Acceptance Criteria
- User can inspect any allowed table fluidly.
- Required DBeaver-like read ergonomics work.
- No write path exists yet.

## Documentation Updates
Document supported read features.

## Handoff Notes
Global visual reference: `../../visuals/neon-command-brand-direction.png`.
