# Slice 00 — Project Manager readiness

## Goal
Act as the Project Manager/orchestrator, execute this readiness Slice yourself, reconcile the handoff against the live VIPER repository and Drive task queue, then dispatch every hard-dependency-ready parallel-safe implementation Slice.

## Context
This task extends existing mission, review, MCP-token, lease/release and telemetry systems. Two overlapping tasks already exist: `viper_mission_ui_redesign_source_truth` and `viper_mission_supervision_agent_telemetry`. Reuse their shipped contracts and avoid duplicate systems.

## Canonical Concepts
`Mission -> MissionRun -> AgentTask -> AgentTaskResult`; `McpToken`; claim lease; task release; mission telemetry session; human review.

## Scope
### In Scope
- Blind repository/context audit from the product goals.
- Compare current implementation/docs with this handoff.
- Inspect active/to-do overlapping tasks and recent changes.
- Reconcile contracts, ownership and migrations.
- Emit one readiness state: `READY`, `CONTEXT_REWORK_REQUIRED`, `CONFLICT`, or `HUMAN_DECISION_REQUIRED`.
- At `READY`, dispatch all currently ready parallel-safe Slices.

### Out of Scope
- Product code changes.

## Dependencies
### Hard `depends_on`
None.

### Soft `requires`
None.

### Can Start With
This handoff, repository `circoe-labs/VIPER`, current Drive task queue.

### Produces
A reconciled execution graph, freshness notes and dispatch decisions.

### Integration Checkpoint
Before any implementation dispatch.

## Implementation Steps
1. Independently inspect mission models/services/routes/MCP tools/telemetry/UI and relevant canonical docs.
2. Inspect current migrations and overlapping handoffs for collisions.
3. Verify that product decisions in `docs/01-decision-log.md` remain compatible with current code.
4. Adjust Slice boundaries only if live ownership changed; record durable changes.
5. Reach exactly one readiness state.
6. If `READY`, dispatch **01, 03 and 04 concurrently** if still parallel-safe; do not dispatch only the lowest number.
7. Re-evaluate graph readiness whenever a Slice finishes, fails or publishes a contract.

## Files Likely Touched
Task/handoff planning files only. PM does not edit product code.

## Architecture Constraints
Do not create parallel identity, heartbeat, review or mission runtime systems. Preserve human validation. No chain-of-thought logging.

## Automated Validation
Repository/contract freshness audit only. Do not launch the full unit test suite in Slice 00.

## Acceptance Criteria
- Readiness state is explicit and justified.
- Overlapping tasks are reconciled.
- Initial ready set is dispatched in parallel when safe.
- Hard dependencies and soft requirements remain truthful.

## Documentation Updates
Update task strategy/LOG only with actual runtime planning notes.

## Handoff Notes
The PM may split, merge, supersede or add Slices when fresh evidence requires it. Re-run a targeted freshness check before every dispatch.
