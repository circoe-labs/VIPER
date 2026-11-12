# Slice 05 — Mission supervision read APIs

## Goal
Expose efficient mission-scoped read models for Overview, Activity, Results and Statistics.

## Context
Implement against the existing VIPER mission/task/result architecture. Do not create parallel identity, review or heartbeat systems.

## Canonical Concepts
Mission, MissionRun, AgentTask, AgentTaskResult, MCP token identity, human review, audit/provenance.

## Scope
### In Scope
Add endpoints/service queries for live overview counters/agent state, paginated activity logs/sessions, result summaries with filters, and statistics/time buckets; reuse existing result review endpoint for full modal payload.

### Out of Scope
Automatic application of agent proposals; chain-of-thought storage; unrelated CRM or outreach features.

## Dependencies
"02","03","04"

## Implementation Steps
1. Perform the Slice freshness check required by Slice 00.
2. Read the canonical mission/agent architecture docs and relevant current implementation/tests.
3. Implement only the contract owned by this Slice.
4. Add/adjust automated tests before declaring completion.
5. Run the required QA agents and resolve regressions.

## Files Likely Touched
backend/app/api/routes/missions.py or dedicated mission supervision router; backend/app/services/missions.py/new supervision service; API tests; frontend/src/api/missions.ts

## Architecture Constraints
- Coding work requires /caveman and /coding-guideline.

- Preserve human validation as the only path that applies agent proposals to business data.
- Preserve organization/actor authorization and audit semantics.

## Automated Validation
Authorization and organization isolation; pagination/filter tests; aggregate correctness; query-count/performance sanity; empty mission behavior.

## Acceptance Criteria
Frontend can render all four tabs without downloading every task/log/result; result summaries include status, agent, timestamps, counts and confidence when available.

## Documentation Updates
Update canonical docs when this Slice changes a repository contract. Do not leave behavior documented only in task files.

## Handoff Notes
If implementation reveals a substantial new dependency, return it to the Project Manager as a new Slice rather than silently expanding scope.
