# Slice 00 — Project Manager readiness

## Goal
Act as Project Manager/orchestrator. Execute this Slice yourself; do not delegate it.

## Context
The task changes a hot prospect-editor surface and overlaps conceptually with a queued graph/scoring handoff.

## Scope
### In Scope
- Blind audit of repository, active branches/tasks and canonical docs.
- Reconcile this handoff with current code and overlapping task `viper_prospect_intelligence_graph_scoring_followups`.
- Decide ownership of hot files and whether any Slice must be merged/superseded.
- Reach one readiness state: `READY`, `CONTEXT_REWORK_REQUIRED`, `CONFLICT`, `HUMAN_DECISION_REQUIRED`.
### Out of Scope
- Product-code edits.
## Dependencies
### Hard `depends_on`
None.
### Soft `requires`
None.
### Can Start With
Repository `circoe-labs/VIPER`, this handoff, source truth and visual reference.
### Produces
Readiness state, updated graph/ownership notes, dispatch set.
### Integration Checkpoint
No implementation dispatch before `READY`.

## Implementation Steps
1. Audit current `main`, docs, migrations, tests and queued/current tasks without assuming this handoff is current.
2. Inspect existing Profil/Suivi implementation, score/data-quality contracts, graph service and mission creation/runtime.
3. Determine status/overlap of `viper_prospect_intelligence_graph_scoring_followups`; explicitly reuse, supersede or carve boundaries.
4. Assign hot-file ownership, especially `ProspectEditor.tsx` and shared CSS.
5. Once READY, dispatch all hard-dependency-ready, parallel-safe Slices, not only the lowest number.
6. Re-evaluate graph after each meaningful completion or contract publication.

## Files Likely Touched
Task docs only.

## Architecture Constraints
PM does not edit product code directly.

## Automated Validation
Repository/context freshness inspection only. Do not run the unit test suite.

## Acceptance Criteria
- Readiness state recorded.
- Overlap decision for graph/proximity is explicit.
- Initial parallel dispatch set is safe and current.
- Testing doctrine preserved.

## Documentation Updates
Update task notes/LOG only with real runtime evidence.

## Handoff Notes
Implementation Slices require `/caveman` + `/coding-guideline`; frontend Slices additionally require `/impeccable` and host frontend routing.
