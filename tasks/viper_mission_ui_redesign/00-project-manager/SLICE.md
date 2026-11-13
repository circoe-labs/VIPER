# Slice 00 — Project Manager readiness gate

## Goal
Act as Project Manager/orchestrator, independently audit the current repository and supplied task evidence, reconcile overlap with existing Mission supervision work, and decide whether implementation can dispatch.

## Context
You execute this Slice yourself and never delegate it. The current repository already documents the Mission supervision stack as shipped; this task is a visual/interaction redesign, not a greenfield telemetry build.

## Canonical Concepts
Mission, MissionRun, AgentTask, AgentTaskResult, mission telemetry/session/activity, human review, visual source of truth.

## Scope
### In Scope
Blind repository audit; current file/API mapping; overlap check with `viper_mission_supervision_agent_telemetry`; validate target screenshots are accessible to implementation agents; identify hot files; resolve valid workspace Task Types; publish readiness state and graph adjustments.
### Out of Scope
Product code edits.

## Dependencies
### Hard `depends_on`
None.
### Soft `requires`
None.
### Can Start With
This handoff, current repository, existing Drive task and supplied visual references.
### Produces
Readiness decision, fresh ownership map, corrected dependency graph if repository drift requires it.
### Integration Checkpoint
No implementation dispatch before `READY`.

## Implementation Steps
1. Audit repository from task goals without assuming this handoff is correct.
2. Read canonical Mission/telemetry/review docs and current frontend/API files.
3. Inspect active/queued overlapping tasks and current branches/PRs when available.
4. Reconcile with this handoff and explicitly classify: `READY`, `CONTEXT_REWORK_REQUIRED`, `CONFLICT`, or `HUMAN_DECISION_REQUIRED`.
5. Confirm visual references are available as implementation evidence; if not, preserve this handoff but stop dispatch because the target cannot be faithfully reproduced.
6. Resolve Task Types and dispatch all hard-dependency-ready, parallel-safe slices after `READY`.
7. Re-evaluate the graph after every meaningful completion/capability publication.

## Files Likely Touched
Task handoff/LOG only. No product code.

## Architecture Constraints
PM does not directly edit product code. Preserve shipped Mission contracts and human validation.

## Automated Validation
Review/read-only evidence only. Do not run the repository unit suite here.

## Acceptance Criteria
Fresh PM can state what already exists, what this redesign changes, which files are hot, and why the graph is safe. No implementation starts below `READY`.

## Documentation Updates
Record substantive graph/contract corrections durably in the task docs/LOG.

## Handoff Notes
If the existing telemetry task is still actively editing the same frontend surfaces, prefer ownership coordination or narrow serialization instead of duplicating work.
