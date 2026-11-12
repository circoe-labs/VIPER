# Slice 01 — Mission telemetry and research-report contract

## Goal
Define the canonical Level-2 contract for mission agent sessions, logs, research-report semantics and inactivity behavior before persistence or tools are implemented.

## Context
Implement against the existing VIPER mission/task/result architecture. Do not create parallel identity, review or heartbeat systems.

## Canonical Concepts
Mission, MissionRun, AgentTask, AgentTaskResult, MCP token identity, human review, audit/provenance.

## Scope
### In Scope
Define session ownership/scope, active-session uniqueness, factual log event taxonomy, shared-vs-own log read policy, 3-hour timeout semantics, retention/audit expectations, and explicit prohibition on chain-of-thought capture.

### Out of Scope
Automatic application of agent proposals; chain-of-thought storage; unrelated CRM or outreach features.

## Dependencies
"00"

## Implementation Steps
1. Perform the Slice freshness check required by Slice 00.
2. Read the canonical mission/agent architecture docs and relevant current implementation/tests.
3. Implement only the contract owned by this Slice.
4. Add/adjust automated tests before declaring completion.
5. Run the required QA agents and resolve regressions.

## Files Likely Touched
doc/architecture/missions.md; doc/architecture/agent-missions.md; new/updated ADR or dedicated mission-telemetry contract

## Architecture Constraints
- Coding work requires /caveman and /coding-guideline.

- Preserve human validation as the only path that applies agent proposals to business data.
- Preserve organization/actor authorization and audit semantics.

## Automated Validation
Documentation consistency checks; architecture review against current claim/heartbeat semantics.

## Acceptance Criteria
A dedicated canonical contract exists; task lease remains 15-minute execution safety while session timeout remains 3-hour supervision state; no ambiguous register/logoff dependency remains.

## Documentation Updates
Update canonical docs when this Slice changes a repository contract. Do not leave behavior documented only in task files.

## Handoff Notes
If implementation reveals a substantial new dependency, return it to the Project Manager as a new Slice rather than silently expanding scope.
