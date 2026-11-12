# Slice 00 — Project Manager readiness gate

## Goal
You are the Project Manager and orchestrator for this handoff. Execute this Slice yourself; do not delegate it. Establish whether the handoff is implementation-ready against the current VIPER repository.

## Context
The handoff was planned from the current Mission UI, functional source of truth and inspected repository contracts. Repository state may change before execution.

## Canonical Concepts
Mission, MissionRun, AgentTask, AgentTaskResult, MCP token identity, claim/lease/heartbeat, human review, evidence.

## Scope
### In Scope
- blind repository/context audit before reading the handoff's documentation-level conclusions;
- inspect current mission/agent models, migrations, APIs, frontend and tests;
- reconcile blind audit with this handoff;
- resolve valid Workspace Task Types for every Slice;
- repair planning if repository reality changed;
- return one readiness state.

### Out of Scope
- editing product code;
- implementing any downstream Slice.

## Dependencies
None.

## Implementation Steps
1. Independently inspect repository architecture relevant to the Slice goals.
2. Only after the blind audit, read `docs/05-documentation-levels.md` and reconcile differences.
3. Validate current Alembic head, API shapes, result proposal shape and Mission UI state.
4. Resolve the Workspace Task Type vocabulary and assign one valid Task Type to each implementation Slice; block any Slice for which no valid type exists.
5. Check that `/caveman`, `/coding-guideline`, and for frontend `/impeccable` are available or identify the workspace-approved replacement policy.
6. Correct stale paths/dependencies, split or add Slices when necessary.
7. Record exactly one state: `READY`, `CONTEXT_REWORK_REQUIRED`, `CONFLICT`, or `HUMAN_DECISION_REQUIRED`.
8. Do not dispatch implementation below `READY`.
9. Immediately before every later dispatch, perform a targeted freshness check.

## Files Likely Touched
Planning files in this task folder only.

## Architecture Constraints
The Project Manager may repair task planning and docs but does not edit product code.

## Automated Validation
- verify every dependency resolves to a Slice ID;
- verify every Human-check ID is unique;
- verify Task Types are valid workspace values;
- verify canonical repository paths still exist.

## Acceptance Criteria
- blind audit recorded;
- reconciliation recorded;
- readiness state recorded;
- Task Types resolved;
- no implementation dispatched unless READY.

## Documentation Updates
Update task planning files if repo reality differs.

## Handoff Notes
QA doctrine from README is mandatory for every implementation Slice.
