# Slice 07 — Agent Activity tab

## Goal
Build a supervision-first activity view showing active/recent agent sessions and factual research logs with clear liveness feedback.

## Context
Implement against the existing VIPER mission/task/result architecture. Do not create parallel identity, review or heartbeat systems.

## Canonical Concepts
Mission, MissionRun, AgentTask, AgentTaskResult, MCP token identity, human review, audit/provenance.

## Scope
### In Scope
Session cards/rows with agent, subject/task, active/idle/timed-out/ended state, last activity and log timeline; filters by agent/status/run; source links and source dates; visible warnings for timed-out/error sessions; sensible polling/refetch behavior.

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
frontend/src/missions/* activity components; frontend/src/api/missions.ts; CSS/tests

## Architecture Constraints
- Coding work requires /caveman and /coding-guideline.
- Frontend work requires /impeccable and should be routed to a Claude agent when supported.
- Preserve human validation as the only path that applies agent proposals to business data.
- Preserve organization/actor authorization and audit semantics.

## Automated Validation
Component tests for live/idle/timed-out states; polling invalidation tests where applicable; accessible source links; no raw chain-of-thought labels/text requested by UI.

## Acceptance Criteria
Activity tab makes multi-agent work understandable at a glance and shows meaningful factual progress without requiring task-row drilling.

## Documentation Updates
Update canonical docs when this Slice changes a repository contract. Do not leave behavior documented only in task files.

## Handoff Notes
If implementation reveals a substantial new dependency, return it to the Project Manager as a new Slice rather than silently expanding scope.
