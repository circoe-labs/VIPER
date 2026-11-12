# Slice 06 — Tabbed Mission shell and Overview feedback

## Goal
Replace the one-page Mission detail layout with a stable four-tab shell and a compact Overview focused on live supervision.

## Context
Implement against the existing VIPER mission/task/result architecture. Do not create parallel identity, review or heartbeat systems.

## Canonical Concepts
Mission, MissionRun, AgentTask, AgentTaskResult, MCP token identity, human review, audit/provenance.

## Scope
### In Scope
Create tabs Vue d'ensemble/Activité/Résultats/Statistiques; preserve mission actions and configuration access; Overview shows compact prompt/targets/config plus live agent count, tasks in progress, results awaiting review, last activity and failure/warning banners.

### Out of Scope
Automatic application of agent proposals; chain-of-thought storage; unrelated CRM or outreach features.

## Dependencies
"05"

## Implementation Steps
1. Perform the Slice freshness check required by Slice 00.
2. Read the canonical mission/agent architecture docs and relevant current implementation/tests.
3. Implement only the contract owned by this Slice.
4. Add/adjust automated tests before declaring completion.
5. Run the required QA agents and resolve regressions.

## Files Likely Touched
frontend/src/missions/MissionDetailPage.tsx; frontend/src/missions/missions.css; frontend/src/api/missions.ts; UI components/tests

## Architecture Constraints
- Coding work requires /caveman and /coding-guideline.
- Frontend work requires /impeccable and should be routed to a Claude agent when supported.
- Preserve human validation as the only path that applies agent proposals to business data.
- Preserve organization/actor authorization and audit semantics.

## Automated Validation
Frontend tests for tab routing/state, Overview empty/loading/error/live states; keyboard tab semantics; responsive layout.

## Acceptance Criteria
User no longer needs to scroll through full executions/tasks to understand mission state; existing edit/pause/delete flows remain reachable and correct.

## Documentation Updates
Update canonical docs when this Slice changes a repository contract. Do not leave behavior documented only in task files.

## Handoff Notes
If implementation reveals a substantial new dependency, return it to the Project Manager as a new Slice rather than silently expanding scope.
