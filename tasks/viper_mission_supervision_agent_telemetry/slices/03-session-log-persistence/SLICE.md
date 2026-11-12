# Slice 03 — Mission agent session and log persistence

## Goal
Add durable, concurrency-safe mission-agent session and append-only activity-log storage plus 3-hour inactivity timeout behavior.

## Context
Implement against the existing VIPER mission/task/result architecture. Do not create parallel identity, review or heartbeat systems.

## Canonical Concepts
Mission, MissionRun, AgentTask, AgentTaskResult, MCP token identity, human review, audit/provenance.

## Scope
### In Scope
Create migration/models/services for MissionAgentSession and MissionAgentLog; active uniqueness per run+agent; touch semantics; explicit end; timeout sweep; indexes/pagination support; audit events where appropriate.

### Out of Scope
Automatic application of agent proposals; chain-of-thought storage; unrelated CRM or outreach features.

## Dependencies
"01"

## Implementation Steps
1. Perform the Slice freshness check required by Slice 00.
2. Read the canonical mission/agent architecture docs and relevant current implementation/tests.
3. Implement only the contract owned by this Slice.
4. Add/adjust automated tests before declaring completion.
5. Run the required QA agents and resolve regressions.

## Files Likely Touched
backend/migrations/versions/<next>.py; backend/app/models/*; backend/app/services/*; model exports; backend tests

## Architecture Constraints
- Coding work requires /caveman and /coding-guideline.

- Preserve human validation as the only path that applies agent proposals to business data.
- Preserve organization/actor authorization and audit semantics.

## Automated Validation
Migration upgrade/downgrade policy per repo; concurrent session-open test; touch/end/timeout tests; organization isolation; index/query tests.

## Acceptance Criteria
Concurrent claims cannot create duplicate active sessions; logs are append-only; timeout after 3 hours records status/reason; existing task lease behavior is unchanged.

## Documentation Updates
Update canonical docs when this Slice changes a repository contract. Do not leave behavior documented only in task files.

## Handoff Notes
If implementation reveals a substantial new dependency, return it to the Project Manager as a new Slice rather than silently expanding scope.
