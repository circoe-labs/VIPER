# Slice 02 — Redesign the general Missions surface

## Goal
Replace the current text-heavy mission tiles with the target portfolio/dashboard presentation so mission state, progress, agent ownership/activity and pending review are readable at a glance.

## Context
Current `MissionsPage.tsx` already provides filters, mission cards, proposal review entry, active switch and action menu. Preserve those behaviors while changing information architecture and visual density.

## Canonical Concepts
Mission status, assigned/automatic agent, recurrence, last/next run, targets, pending reviews, activate/pause/edit/delete.

## Scope
### In Scope
Target-aligned header/filter controls; mission card/list hierarchy; compact mission status/progress/activity summaries; clearer pending-review affordance; sensible grouping of secondary metadata; responsive layouts; empty/loading/error states.
### Out of Scope
Statistics tab; review-dialog redesign; telemetry persistence/API creation.

## Dependencies
### Hard `depends_on`
- 01: shared visual contract and hot-file ownership must be fixed first.
### Soft `requires`
- Current mission card fields. Need: truthful progress/activity value if target demands one. Fallback: use existing last-run/pending/agent/status facts and omit unsupported progress. Integration required before 05. Mismatch policy: request one minimal read-model addition; never synthesize progress.
### Can Start With
Existing `useMissions`, `MissionCard`, current actions and Slice 01 primitives.
### Produces
Redesigned Missions list surface and any narrowly scoped view-model adapter.
### Integration Checkpoint
Before 05, all visible values must be backed by live data and mission actions must remain functional.

## Implementation Steps
1. Load `/caveman`, `/coding-guideline`, `/impeccable`; follow frontend-agent routing.
2. Refactor Mission tile composition to match target visual hierarchy.
3. Preserve right-click/menu, switch, navigation and review entry semantics.
4. Use surface-specific components/styles to avoid conflicts with 03/04.
5. Validate keyboard/focus and responsive behavior.
6. Run code review plus focused build/type/runtime smoke only; no full unit suite.

## Files Likely Touched
`frontend/src/missions/MissionsPage.tsx`; new `MissionList*` components/styles; mission card formatting helpers; narrowly scoped tests/fixtures.

## Architecture Constraints
No changes to mission execution semantics. No commercial funnel KPIs. Do not regress accessible link/button nesting.

## Automated Validation
Type/build/static checks; targeted render smoke for active/paused/done/error/pending-review cards; keyboard action-menu check. Do not launch the unit test suite at this Slice boundary.

## Acceptance Criteria
The list visually matches the target intent and lets the user identify mission status, ownership/activity and attention needed without reading paragraph-like cards.

## Documentation Updates
Update UI docs only if a reusable Mission list contract is introduced.

## Handoff Notes
If a missing activity/progress field is found, isolate it behind a small adapter/read-model request and continue independent layout work.
