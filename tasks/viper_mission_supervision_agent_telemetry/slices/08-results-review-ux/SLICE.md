# Slice 08 — Results tab and review dialog redesign

## Goal
Create a dedicated result review queue and redesign the validation modal around confidence, evidence freshness and fast accept/reject decisions.

## Context
Implement against the existing VIPER mission/task/result architecture. Do not create parallel identity, review or heartbeat systems.

## Canonical Concepts
Mission, MissionRun, AgentTask, AgentTaskResult, MCP token identity, human review, audit/provenance.

## Scope
### In Scope
Result summary cards with status/date/agent/task/subject/counts/confidence; filters; click opens ReviewDialog; prominent global confidence; per-line confidence/source/publication-or-freshness/checked-at; agent research report section; rejection reason appears only after Reject action; preserve partial selection and existing accept semantics.

### Out of Scope
Automatic application of agent proposals; chain-of-thought storage; unrelated CRM or outreach features.

## Dependencies
"02","05","06"

## Implementation Steps
1. Perform the Slice freshness check required by Slice 00.
2. Read the canonical mission/agent architecture docs and relevant current implementation/tests.
3. Implement only the contract owned by this Slice.
4. Add/adjust automated tests before declaring completion.
5. Run the required QA agents and resolve regressions.

## Files Likely Touched
frontend/src/agents/ReviewDialog.tsx; frontend/src/agents/agents.css; frontend/src/api/agents.ts; frontend/src/missions/* results components; tests

## Architecture Constraints
- Coding work requires /caveman and /coding-guideline.
- Frontend work requires /impeccable and should be routed to a Claude agent when supported.
- Preserve human validation as the only path that applies agent proposals to business data.
- Preserve organization/actor authorization and audit semantics.

## Automated Validation
Tests for historical results with missing new metadata; partial acceptance; reject modal/step requiring reason; keyboard/focus behavior; source/date rendering; result filters.

## Acceptance Criteria
Reviewers can assess result quality without opening raw JSON; rejection field no longer clutters normal review; all existing human-review safeguards remain intact.

## Documentation Updates
Update canonical docs when this Slice changes a repository contract. Do not leave behavior documented only in task files.

## Handoff Notes
If implementation reveals a substantial new dependency, return it to the Project Manager as a new Slice rather than silently expanding scope.
