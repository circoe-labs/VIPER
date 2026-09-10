# Task 20 — Integration hardening and release report

## Goal
Run the complete V1 as an integrated system, close correctness/security/UX gaps and produce the final implementation report.

## Context
This is a release gate, not a place to add new features.

## Coding Skill Requirement
Before editing code, load and follow `/caveman` and `/coding-guideline` from `~/ai/skills/`.

## Scope
### In Scope
- Full test/E2E suite.
- Private local BASE_CLIENT import compatibility run without committing/logging PII.
- Import→edit→export.
- Company/Prospect/Settings flows.
- Contactability and verification semantics.
- Database Explorer read/edit/SQL safety.
- Home drilldowns.
- Auth/session/security review.
- Theme/logo checks.
- Performance/accessibility/error/loading/empty states.
- Backup/retention/deployment open decisions clearly reported.
- Final implementation report.

### Out of Scope
- No new product scope.
- No agents/mail/Calendly unless separately approved later.

## Dependencies
Tasks 01-19 except explicitly deferred optional Task 17 if documented.

## Implementation Steps
1. Clean install/migrate/seed.
2. Run automated suite.
3. Run private legacy workbook compatibility scenario.
4. Run user-critical E2E flows.
5. Review public-repo data leakage and secrets.
6. Review performance/accessibility/visual alignment.
7. Fix regressions only.
8. Produce final report with unresolved deployment/legal/ops decisions.

## Files Likely Touched
Cross-project tests, docs, deployment config, final report.

## Architecture Constraints
Do not weaken guards to make tests pass. Do not commit private source data. No fake future capabilities.

## Testing Requirements
All prior task gates, private-data leak check, DNC persistence, auth, SQL read-only, import/export fidelity, keyboard/accessibility, common laptop viewport.

## Acceptance Criteria
- V1 runs end-to-end.
- Core workflows are reliable.
- Private data remains private.
- No known source-of-truth contradiction remains undocumented.
- Final report complete.

## Documentation Updates
Finalize README/runbook/implementation report using template.

## Handoff Notes
Use `../../templates/final-implementation-report-template.md`.
