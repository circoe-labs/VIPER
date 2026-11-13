# Slice 04 — Redesign Mission detail and result-validation surface

## Goal
Make the individual Mission screen match the target supervision/review composition, with concise mission context, agent progress and a clear accept/reject result workflow.

## Context
Current `MissionDetailPage` already has header actions, live strip, tabs and result review. Current `ReviewDialog` already protects human validation. Recompose these capabilities rather than replacing them.

## Canonical Concepts
Mission summary, live supervision, result queue, confidence/evidence, human accept/reject, partial review semantics.

## Scope
### In Scope
Target-aligned mission header/summary; compact agent/run/task progress; result summary and evidence composition; accept/reject affordances; confidence/source/freshness/report presentation where present; responsive/focus behavior; removal of unnecessary visual clutter.
### Out of Scope
Automatic acceptance; changing proposal normalization semantics; new telemetry/session architecture; statistics screen.

## Dependencies
### Hard `depends_on`
- 01: shared visual contract and component ownership required.
### Soft `requires`
- Existing overview/results/review payloads. Need: evidence/confidence/report fields already shipped. Fallback: graceful historical-result rendering with missing metadata. Integration required before 05. Mismatch policy: adapt presentation to nullable fields, request only minimal read-model exposure where facts already exist.
### Can Start With
`MissionDetailPage`, `MissionLiveStrip`, Results components, `ReviewDialog` and current review subcomponents.
### Produces
Redesigned mission detail and review experience without changing decision semantics.
### Integration Checkpoint
Before 05, accept/reject/partial selection and mission actions must work exactly as before against live APIs.

## Implementation Steps
1. Load `/caveman`, `/coding-guideline`, `/impeccable`; follow frontend-agent routing.
2. Recompose mission header/live summary according to target hierarchy.
3. Redesign result/review composition while preserving normalized proposal actions.
4. Keep source links, confidence and freshness readable; handle nullable historical data.
5. Verify rejection reason is requested only when appropriate and acceptance never requires one.
6. Validate focus trap, keyboard navigation, destructive-action clarity and responsive behavior.
7. Run code review plus focused build/type/runtime smoke; no full unit suite.

## Files Likely Touched
`frontend/src/missions/MissionDetailPage.tsx`; mission result/detail components and surface-specific styles; `frontend/src/agents/ReviewDialog.tsx` plus review subcomponents/styles where needed.

## Architecture Constraints
Human review remains the only proposal-application path. No raw chain-of-thought. Do not change mission lifecycle behavior for visual convenience.

## Automated Validation
Focused smoke for pending/accepted/rejected/historical results, partial selection, source/evidence display, accept/reject actions, focus/keyboard behavior. Do not launch the unit test suite at this Slice boundary.

## Acceptance Criteria
The user can understand one mission and decide on its results quickly, with the target visual hierarchy and no loss of existing safeguards or actions.

## Documentation Updates
Update review UI documentation only if interaction contract changes; do not duplicate domain review contracts.

## Handoff Notes
Coordinate any shared `ReviewDialog` style changes with other active branches touching agent review UX.
