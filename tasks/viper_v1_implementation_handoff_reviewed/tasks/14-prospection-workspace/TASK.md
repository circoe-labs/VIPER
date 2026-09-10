# Task 14 — Implement Prospection counters, filters and people list

## Goal
Build the daily human workspace for isolating people to verify/contact and moving efficiently through the queue.

## Context
Prospection is explicitly a readable list, not a raw data grid. Counters are actionable filters.

## Coding Skill Requirement
Before editing code, load and follow `/caveman` and `/coding-guideline` from `~/ai/skills/`.

## Scope
### In Scope
- Counters: total, never verified, needs re-check, Active/Unknown/Inactive, contactability blocked, due/to contact, contacted/no-response, responses, appointments as coherent real-data set.
- Counter click filters list.
- Search person/company/email.
- Filters/sort/pagination.
- Readable prospect rows.
- Import/Export/Add buttons.
- Open Prospect editor contract.
- URL/query filter persistence where useful.

### Out of Scope
- No raw Database controls.
- No agent suggestions.
- No full editor implementation here.

## Dependencies
Tasks 02-03, 09-10.

## Implementation Steps
1. Define typed list/filter model.
2. Build aggregate counters from same semantics.
3. Build list/search/filter/sort.
4. Wire import/export/add entrypoints.
5. Add empty/loading/error states.
6. Test filter drill-down.

## Files Likely Touched
Prospection route/components, query service, filters, tests.

## Architecture Constraints
Counters/list use same source-of-truth status semantics. Avoid N+1. Stale threshold remains configurable/unresolved.

## Testing Requirements
Counter→filter, combined filters, search, no-response derivation, contactability filter, pagination/performance, empty states.

## Acceptance Criteria
- User can isolate next records quickly.
- Cards are functional filters.
- List is spacious and human-readable.

## Documentation Updates
Document KPI/filter definitions.

## Handoff Notes
Global visual reference: `../../visuals/neon-command-brand-direction.png`.
