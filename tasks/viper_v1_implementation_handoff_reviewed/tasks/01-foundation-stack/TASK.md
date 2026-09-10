# Task 01 — Choose stack and scaffold the application

## Goal
Create the minimal production-capable typed web foundation, relational persistence scaffold, tests and CI baseline.

## Context
No stack was locked. Prefer existing Circoe conventions if they now exist; otherwise choose a boring typed stack with strong migrations/testability.

## Coding Skill Requirement
Before editing code, load and follow `/caveman` and `/coding-guideline` from `~/ai/skills/`.

## Scope
### In Scope
- Frontend/backend/data boundary.
- Package/tooling, lint/typecheck/tests.
- Relational DB connectivity + migration command.
- Route shell placeholders without fake business data.
- CI baseline.
- `.gitignore`/local-dev conventions protecting private source workbook.

### Out of Scope
- No feature UI/data model beyond migration smoke.
- No agents/mail/Calendly.

## Dependencies
Task 00.

## Implementation Steps
1. Inspect repo conventions.
2. Document stack ADR.
3. Scaffold app/server/data boundaries.
4. Configure DB/migrations.
5. Configure lint/typecheck/test/build.
6. Configure CI without uploading private files.
7. Add local environment instructions.

## Files Likely Touched
Root project files, app/server source skeleton, DB config, CI, README, ignore rules.

## Architecture Constraints
UI components do not access SQL/ORM directly. Typed config. No secrets or real client data committed.

## Testing Requirements
Fresh install, build, lint, typecheck, unit smoke, app boot, migration smoke, git check that private workbook is excluded.

## Acceptance Criteria
- Fresh clone boots.
- CI baseline green.
- Stack decision documented.
- Private source handling is explicit.

## Documentation Updates
Update repo README + ADR.

## Handoff Notes
Global visual styling comes in Task 02.
