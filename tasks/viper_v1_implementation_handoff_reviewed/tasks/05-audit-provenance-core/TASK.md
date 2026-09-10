# Task 05 — Implement audit and provenance core before feature mutations

## Goal
Provide append-only mutation audit and prospect/contact provenance services used by import, forms and Database Explorer.

## Context
The first handoff put audit too late. All later mutation-heavy tasks must depend on this core.

## Coding Skill Requirement
Before editing code, load and follow `/caveman` and `/coding-guideline` from `~/ai/skills/`.

## Scope
### In Scope
- AuditService API and storage.
- Actor/source types: human, import, system, future agent.
- ProspectSource/ProvenanceService.
- Before/after change summaries with safe payload filtering.
- Import-batch provenance helpers.
- Service integration hooks/patterns.

### Out of Scope
- No full visible timeline UI yet.
- No rollback engine.
- No SIEM/event bus.

## Dependencies
Tasks 03-04.

## Implementation Steps
1. Define typed audit/provenance contracts.
2. Implement append-only writes.
3. Add safe serializer/filter for changes.
4. Add provenance create/query helpers.
5. Document required mutation integration pattern.
6. Add tests.

## Files Likely Touched
Audit/provenance services/repos/types/tests.

## Architecture Constraints
Never log secrets or unnecessary raw PII payloads. Audit actor comes from server ActorContext. Provenance and audit are separate concepts.

## Testing Requirements
Human mutation, import actor, source metadata, safe before/after, ordering, append-only behavior.

## Acceptance Criteria
- Later tasks can emit audit events through a stable service.
- Prospect source/date/legal-context can be stored.
- Actor attribution works.

## Documentation Updates
Document event/provenance schemas.

## Handoff Notes
Visible history appears in Task 19, but audit generation starts now.
