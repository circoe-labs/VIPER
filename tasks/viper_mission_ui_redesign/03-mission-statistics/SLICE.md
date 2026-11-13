# Slice 03 — Redesign Mission statistics around agent execution

## Goal
Build the target statistics screen using only mission-execution telemetry and truthful derived aggregates.

## Context
The user explicitly rejected CRM/email/prospecting statistics in this surface. This screen explains how agents executed one mission.

## Canonical Concepts
Agent session/activity, tasks, results, review states, API/tool-call telemetry when factual, warnings/errors/timeouts, run history.

## Scope
### In Scope
Top KPI strip; donut/pie breakdowns for categorical states where meaningful; time/activity charts; per-agent distribution; API/tool-call counts and averages only if telemetry supports them; errors/warnings; result/review state distribution; accessible tables/text alternatives; zero/partial-data handling.
### Out of Scope
Emails sent, replies, Calendly, pipeline conversion, quote/order/revenue metrics; fabricated call counts.

## Dependencies
### Hard `depends_on`
- 01: shared visual/chart contract is required.
### Soft `requires`
- Existing mission statistics/activity APIs. Need: exact semantics of available counters/events. Fallback: build transformations against current typed payload/fixtures, mark unsupported values unavailable. Integration required before 05. Mismatch policy: smallest read-model extension possible, no new persistence model.
### Can Start With
Current Stats tab/hooks and mission telemetry docs.
### Produces
Redesigned mission-specific statistics components and deterministic transformation layer.
### Integration Checkpoint
Before 05 every KPI/chart must have documented source fields and aggregation semantics.

## Implementation Steps
1. Load `/caveman`, `/coding-guideline`, `/impeccable`; follow frontend-agent routing.
2. Inventory actual stats/activity payloads and map them to the target visual.
3. Implement deterministic selectors/transformers separately from chart rendering.
4. Add donut/pie charts only for valid categorical distributions; include text/table alternatives.
5. Show API/tool calls only if the data contract explicitly records them; otherwise omit or label unavailable.
6. Add partial/zero/error states and timezone-consistent buckets.
7. Run code review plus focused build/type/runtime smoke; no full unit suite.

## Files Likely Touched
Current `StatsTab`/statistics components under `frontend/src/missions`; new statistics-specific stylesheet; mission API types/selectors; minimal backend aggregate route only if proven necessary.

## Architecture Constraints
Statistics must describe mission execution, not the broader commercial pipeline. No invented telemetry.

## Automated Validation
Transformation checks against representative fixtures, chart/table parity smoke, zero/partial-data rendering, accessibility inspection. Do not launch the unit test suite at this Slice boundary.

## Acceptance Criteria
A user can understand who/what worked on the mission, how much activity occurred, where errors/waits happened, and how results were produced/reviewed, without seeing unrelated sales KPIs.

## Documentation Updates
Document any newly exposed aggregate field with exact semantics and null/zero behavior.

## Handoff Notes
If tool/API calls are not currently tracked as a first-class factual event, do not infer them from generic logs.
