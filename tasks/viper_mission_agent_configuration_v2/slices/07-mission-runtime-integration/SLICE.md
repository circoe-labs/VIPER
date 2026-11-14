# Slice 07 — Mission runtime convergence

## Goal
Integrate category defaults, source knowledge, numbered agents and mission-specific output contracts into the live Mission claim/submit/review runtime without duplicating existing orchestration.

## Context
Slices 01-04 intentionally own separate persistence/runtime boundaries. This Slice reconciles them at task generation, claim payload, evidence handling, completion and review.

## Canonical Concepts
Mission -> Run -> Task -> Result, token identity, source evidence, output schema, review/apply.

## Scope
### In Scope
- Task generation consumes category technical mapping and mission overrides.
- Claim payload includes effective prompt/skills, external research sources, resolved internal VIPER context sources, one target where appropriate, mission objective/progress and output contract/version.
- Source hierarchy/evidence IDs reconcile with submitted result evidence.
- Agent identity labels/session logs are coherent throughout task lifecycle.
- Submission validates output contract, normalizes evidence and produces review proposal.
- Successful-source counters update at the correct accepted/validated lifecycle point with idempotency.
- Mission/task/run completion derives from server-side task/result/review state, explicit not-found/failure outcomes and the mission objective. One-off missions close at fulfilled objective; recurring runs reset objective per interval and do not prematurely close the parent mission.
- Explicit release/leave semantics do not strand tasks/sessions.
- Remove/deprecate mission direct-write/staged-action paths where they conflict with the locked proposal-first contract, while preserving any required tool-mode behavior outside mission execution.

### Out of Scope
- Admin UI implementation.
- Voice UI implementation.

## Dependencies
### Hard `depends_on`
- Slice 01: category/skill effective config.
- Slice 02: source/evidence model.
- Slice 03: identity/lifecycle contract.
- Slice 04: output contract generator/validator.

### Soft `requires`
- Slice 05 admin UI and Slice 06 voice authoring: need final API usage assumptions for product integration. Fallback is backend/API contract smoke fixtures. Mandatory before Slice 08, not before backend runtime work starts.

### Can Start With
Published contracts/artifacts from Slices 01-04 and existing mission/MCP/review code.

### Produces
A coherent end-to-end backend mission execution contract and compatibility/deprecation path.

### Integration Checkpoint
Before Slice 08.

## Implementation Steps
1. Reconcile shared files/call sites and remove duplicated provisional adapters.
2. Compute effective mission config: category defaults + sticky mission overrides.
3. Generate task payload with prompt, instruction skills, external sources, resolved internal context records, target, run objective/progress and output contract.
4. Validate submitted data and map evidence to reusable sources/concrete citations.
5. Ensure counters increment at the chosen validated lifecycle point exactly once.
6. Ensure one-item workflow and `allow_multiple` behavior create sensible next work/task progression and objective progress.
7. Reuse existing recurrence scheduler/end rules; instantiate/reset objective at run boundaries and close one-off missions only when objective is fulfilled.
8. Reconcile release/end-session and timeout behavior.
9. Audit any existing staged/direct mission action paths; keep only behavior compatible with “agent proposes, VIPER interprets/reviews/applies”.
10. Emit real MCP traces for claim -> work -> submit/release -> review-facing result, including internal-context resolution and objective progression.

## Files Likely Touched
Mission services/task generation, agent payload/result/review services, MCP handlers, source evidence bridge, docs.

## Architecture Constraints
- Preserve tool-mode behavior if it is intentionally distinct from mission mode.
- Human review remains mandatory.
- No private reasoning capture.
- `/caveman` and `/coding-guideline` required.

## Automated Validation
Targeted integration smoke plus real MCP trace analysis. Do not launch the full unit test suite at this Slice boundary.

## Acceptance Criteria
- Claim receives effective category/mission instructions, external sources, resolved internal context and objective/progress state.
- Targeted mission work exposes only the current target.
- Submit conforms to mission output contract and creates reviewable proposal.
- Evidence maps to source hierarchy and counter semantics without double-counting.
- Agent can submit, release or finish without lifecycle dead-end.
- One-off/recurring completion follows objective + existing recurrence semantics with no duplicate scheduler.

## Documentation Updates
Reconcile canonical missions/agent-missions/MCP/telemetry docs so one contract remains authoritative.

## Handoff Notes
Publish any compatibility/deprecation decisions for final QA.
