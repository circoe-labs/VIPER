# Slice 04 — MCP mission session and logging integration

## Goal
Integrate automatic mission sessions with claim/heartbeat and expose safe mission-log read/write/end controls plus agent-facing logging guidance.

## Context
Implement against the existing VIPER mission/task/result architecture. Do not create parallel identity, review or heartbeat systems.

## Canonical Concepts
Mission, MissionRun, AgentTask, AgentTaskResult, MCP token identity, human review, audit/provenance.

## Scope
### In Scope
On claim of a mission task open/reuse session; on heartbeat/log writes touch last_seen_at; expose mission-scoped read/write/end tools and optional explicit start if contract keeps it; include session/logging instructions in claimed mission payload; ensure fail/release/submit semantics remain unchanged.

### Out of Scope
Automatic application of agent proposals; chain-of-thought storage; unrelated CRM or outreach features.

## Dependencies
"01","03"

## Implementation Steps
1. Perform the Slice freshness check required by Slice 00.
2. Read the canonical mission/agent architecture docs and relevant current implementation/tests.
3. Implement only the contract owned by this Slice.
4. Add/adjust automated tests before declaring completion.
5. Run the required QA agents and resolve regressions.

## Files Likely Touched
backend/app/api/mcp.py; backend/app/services/agent_missions.py; backend/app/services/agent_payloads.py; MCP docs/tests

## Architecture Constraints
- Coding work requires /caveman and /coding-guideline.

- Preserve human validation as the only path that applies agent proposals to business data.
- Preserve organization/actor authorization and audit semantics.

## Automated Validation
MCP capability/auth tests; trace showing claim -> session -> write_log -> heartbeat -> read_logs -> submit/end; invalid cross-mission access tests; timeout interaction tests.

## Acceptance Criteria
An authenticated agent cannot spoof agent_id; mission session exists without requiring an explicit register call; meaningful logging instructions are delivered; logs contain factual summaries rather than requested hidden reasoning.

## Documentation Updates
Update canonical docs when this Slice changes a repository contract. Do not leave behavior documented only in task files.

## Handoff Notes
If implementation reveals a substantial new dependency, return it to the Project Manager as a new Slice rather than silently expanding scope.
