# Slice 09 — Mission Statistics tab

## Goal
Add useful chronological and aggregate mission metrics derived from tasks/results/log events, segmented by agent where helpful.

## Context
Implement against the existing VIPER mission/task/result architecture. Do not create parallel identity, review or heartbeat systems.

## Canonical Concepts
Mission, MissionRun, AgentTask, AgentTaskResult, MCP token identity, human review, audit/provenance.

## Scope
### In Scope
Counters for accepted/refused/waiting/errors; production metrics appropriate to result kind; time-bucket activity/results; per-agent segmentation; sources consulted/log count where meaningful; charts with non-visual alternatives; avoid fake metrics not supported by data.

### Out of Scope
Automatic application of agent proposals; chain-of-thought storage; unrelated CRM or outreach features.

## Dependencies
"04","05","06"

## Implementation Steps
1. Perform the Slice freshness check required by Slice 00.
2. Read the canonical mission/agent architecture docs and relevant current implementation/tests.
3. Implement only the contract owned by this Slice.
4. Add/adjust automated tests before declaring completion.
5. Run the required QA agents and resolve regressions.

## Files Likely Touched
frontend/src/missions/* statistics components; frontend/src/api/missions.ts; backend aggregate query adjustments if needed; tests

## Architecture Constraints
- Coding work requires /caveman and /coding-guideline.
- Frontend work requires /impeccable and should be routed to a Claude agent when supported.
- Preserve human validation as the only path that applies agent proposals to business data.
- Preserve organization/actor authorization and audit semantics.

## Automated Validation
Aggregate fixture tests; chart data transformation tests; zero-data state; accessibility/table alternative; timezone consistency.

## Acceptance Criteria
Statistics accurately reflect mission history and agents, with result-kind-aware metrics and no hard-coded misleading KPI for unsupported mission types.

## Documentation Updates
Update canonical docs when this Slice changes a repository contract. Do not leave behavior documented only in task files.

## Handoff Notes
If implementation reveals a substantial new dependency, return it to the Project Manager as a new Slice rather than silently expanding scope.
