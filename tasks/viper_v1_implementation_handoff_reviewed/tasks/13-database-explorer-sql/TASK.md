# Task 13 — Add backend-enforced read-only SQL console

## Goal
Provide the discreet advanced SQL query surface requested by the user without turning VIPER into a SQL IDE or write backdoor.

## Context
SQL is a power-user Database feature. It must remain read-only in V1 and safely resource-bounded.

## Coding Skill Requirement
Before editing code, load and follow `/caveman` and `/coding-guideline` from `~/ai/skills/`.

## Scope
### In Scope
- Compact SQL editor/field.
- Execute SELECT/read-only query.
- Render result grid.
- Server-side read-only enforcement.
- Parameter/resource/time/row limits appropriate to stack.
- Clear errors.

### Out of Scope
- No UPDATE/DELETE/INSERT/DDL.
- No multi-statement write tricks.
- No migration/schema editor.

## Dependencies
Tasks 11-12.

## Implementation Steps
1. Choose parser/database-enforced read-only strategy.
2. Build execution service with limits.
3. Add UI/result grid.
4. Add security regression suite.

## Files Likely Touched
SQL explorer service, UI console, tests.

## Architecture Constraints
Frontend checks are insufficient; backend/database role must prevent writes. Avoid exposing secrets/system tables if platform requires restrictions.

## Testing Requirements
Blocked DML/DDL/multi-statement attempts, valid SELECT, limits/timeouts, errors, auth required.

## Acceptance Criteria
- SELECT queries work.
- Write attempts are impossible through this path.
- UI remains compact/discreet.

## Documentation Updates
Document SQL capabilities/limits.

## Handoff Notes
Do not overbuild query tabs/history/autocomplete unless trivial and non-distracting.
