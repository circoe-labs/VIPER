# Task 04 — Implement secure single-user authentication and actor context

## Goal
Protect VIPER routes with secure pilot authentication and establish stable human actor identity for audit.

## Context
The source-of-truth requires one authenticated commercial user. Keep this deliberately small; internal referents are separate domain records.

## Coding Skill Requirement
Before editing code, load and follow `/caveman` and `/coding-guideline` from `~/ai/skills/`.

## Scope
### In Scope
- Secure login/session approach appropriate to chosen stack.
- Protected app routes/API.
- ActorContext available to mutation services.
- Logout/session expiry/error handling.
- Local/dev bootstrap without committing secrets.

### Out of Scope
- No RBAC matrix.
- No SSO enterprise project unless existing conventions make it trivial.
- Do not turn all internal referents into users.

## Dependencies
Tasks 01 and 03.

## Implementation Steps
1. Choose auth mechanism consistent with stack.
2. Add user/account/session minimal schema if needed.
3. Protect routes.
4. Expose actor identity to services.
5. Add tests and setup docs.

## Files Likely Touched
Auth config/routes/middleware/session storage, actor-context abstraction, tests.

## Architecture Constraints
Passwords/secrets never stored/logged insecurely. Use framework best practices. Actor identity must be available server-side, not trusted from client payload.

## Testing Requirements
Unauthenticated access blocked, login/logout/session tests, actor propagation test, no-secret lint/config review.

## Acceptance Criteria
- App requires authentication.
- One pilot user can operate it.
- Mutations can identify the authenticated human actor.
- Internal referents remain separate.

## Documentation Updates
Document local/admin setup and secret handling.

## Handoff Notes
Exact production identity provider can be revisited later without changing domain referent records.
