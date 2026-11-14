# Slice 08 — Final integration, full tests and product validation

## Goal
Prove the complete feature graph works together, resolve integration mismatches, run the single broad test campaign and produce final QA evidence.

## Context
This is the only convergence Slice that runs the full unit/integration/E2E campaign. It verifies backend contracts, admin UI, mission creation/voice flow and real MCP agent behavior together.

## Canonical Concepts
All task concepts.

## Scope
### In Scope
- Fresh integration audit of all predecessor outputs.
- Resolve soft-requirement seams and compatibility adapters.
- Full unit test suite once.
- Full relevant integration/E2E suite once.
- Real agent-trace analysis for identity, claim, payload, evidence, submit/release/end-session.
- Browser validation for admin navigation, category/skill/external-source management, internal-context linking, mission-creator prompt settings, category visual identity and voice mission authoring.
- Migration/backfill validation from representative existing mission/source data.
- Accessibility and visual hierarchy checks for new admin/voice UI.

### Out of Scope
- New product scope unrelated to regressions/integration fixes.

## Dependencies
### Hard `depends_on`
- Slice 05 complete.
- Slice 06 complete.
- Slice 07 complete.

### Soft `requires`
None.

### Can Start With
All implementation artifacts and predecessor QA evidence.

### Produces
Final integrated implementation, test results, trace evidence and acceptance decision.

### Integration Checkpoint
This is the final checkpoint.

## Implementation Steps
1. Reconcile APIs/types/migrations/UI contracts and remove stale fixtures/adapters.
2. Run unit and E2E/integration suites concurrently when isolation/resources allow; otherwise in the same final phase.
3. Execute representative migration/backfill and rollback/forward checks as appropriate.
4. Execute real MCP agent traces for multiple owner agents, scheduled reservation, one-item result, evidence and release/end-session.
5. Validate admin category/skill/external-source flows, internal-context linking, mission-creator prompt editing/reset and mission category color/icon.
6. Validate mission objective lifecycle: one-off completion on objective, recurring per-run objective reset on interval, existing recurrence end rules and no duplicate scheduler.
7. Validate voice flow including permissions failure, clarification, external/internal source selection, objective/recurrence draft actions, configured creator prompt, create bypass intent and cancel.
8. Attribute failures to responsible Slice, fix and run targeted checks; repeat necessary final gate.

## Files Likely Touched
Only integration fixes, tests and documentation/evidence required by failures.

## Architecture Constraints
Do not weaken review, audit, auth or telemetry invariants to make tests pass.

## Automated Validation
This Slice owns the **complete unit, integration and E2E test suites** plus real agent traces. Capture all outcomes. This is the single broad validation phase required by the task.

## Acceptance Criteria
- All required suites pass.
- Existing mission data migrates safely.
- Category defaults/overrides behave correctly.
- External source effectiveness counters are truthful/idempotent and internal context references remain read-only/distinct from targets.
- Agent identity/lifecycle works under multiple conversations and scheduled agent cases.
- Output contract prevents cosmetic/unchanged rewrites and honors multiplicity.
- Objective/recurrence semantics complete one-off missions correctly and repeat recurring objectives per period using the existing scheduler.
- Mission-creator prompt setting is honored by subsequent creator conversations.
- Admin UI/navigation and voice authoring are usable and accessible.
- No regression in human review or existing mission execution.

## Documentation Updates
Finalize canonical docs and implementation notes; no contradictory task-only contract remains.

## Handoff Notes
Final QA agent returns evidence/findings; PM makes final accept/rework decision.
