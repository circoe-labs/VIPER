# Slice 02 — Per-item confidence and source freshness

## Goal
Extend agent result evidence and normalized proposals so each reviewable item can carry confidence and source-date metadata without breaking historical results.

## Context
Implement against the existing VIPER mission/task/result architecture. Do not create parallel identity, review or heartbeat systems.

## Canonical Concepts
Mission, MissionRun, AgentTask, AgentTaskResult, MCP token identity, human review, audit/provenance.

## Scope
### In Scope
Add nullable per-evidence confidence, source publication/freshness timestamp/date, and checked-at timestamp; map evidence to normalized proposal items; increment output schema version if required; preserve old stored results.

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
backend/app/services/agent_payloads.py; backend/app/services/agent_review.py and proposal builders; backend tests; frontend/src/api/agents.ts contract types; canonical docs

## Architecture Constraints
- Coding work requires /caveman and /coding-guideline.

- Preserve human validation as the only path that applies agent proposals to business data.
- Preserve organization/actor authorization and audit semantics.

## Automated Validation
Schema validation tests for old/new payloads; proposal normalization tests; invalid/future date cases; no invented publication date.

## Acceptance Criteria
Review API returns per-item confidence/source metadata where supplied; old results still render; publication date may be null; checked-at is distinct and trustworthy.

## Documentation Updates
Update canonical docs when this Slice changes a repository contract. Do not leave behavior documented only in task files.

## Handoff Notes
If implementation reveals a substantial new dependency, return it to the Project Manager as a new Slice rather than silently expanding scope.
