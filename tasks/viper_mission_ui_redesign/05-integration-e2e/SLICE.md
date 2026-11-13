# Slice 05 — Integration, visual convergence and final validation

## Goal
Converge the three redesigned Mission surfaces, prove behavioral compatibility, and perform the task's single full test/visual QA phase.

## Context
This is the final convergence point. It validates the redesign as one product rather than three isolated screens.

## Canonical Concepts
Mission navigation, mission actions, supervision statistics, result review, accessibility, visual source of truth.

## Scope
### In Scope
Merge/integration defects; shared style consistency; list -> detail -> stats -> results navigation; live API wiring; accept/reject flows; responsive behavior; accessibility; visual comparison to all three target screens; canonical docs synchronization.
### Out of Scope
New product scope unrelated to defects required for acceptance.

## Dependencies
### Hard `depends_on`
- 02: general Missions surface complete.
- 03: Mission statistics surface complete.
- 04: Mission detail/review surface complete.
### Soft `requires`
None; all consumed product outcomes must be live before final acceptance.
### Can Start With
Completed 02/03/04 branches/artifacts.
### Produces
Integrated redesign, complete QA evidence, final documentation state.
### Integration Checkpoint
This Slice is the checkpoint.

## Implementation Steps
1. Load `/caveman`, `/coding-guideline`, `/impeccable` for any fixes; follow frontend routing.
2. Reconcile shared styles/components and eliminate visual drift between surfaces.
3. Run full unit suites and integration/E2E suites in the same final phase, concurrently when safe.
4. Execute E2E: Missions list -> open mission -> statistics -> results -> accept/reject; include active/paused and pending-review cases.
5. Perform accessibility checks and keyboard-only pass.
6. Compare all three surfaces against the supplied visual source of truth at representative desktop widths plus responsive widths.
7. Attribute failures to responsible slices, apply fixes, run targeted checks, then repeat necessary final gates.
8. Update canonical documentation where implementation contracts changed.

## Files Likely Touched
E2E tests, shared Mission styling/primitives, defect fixes across owned surfaces, canonical docs.

## Architecture Constraints
No known regression can be parked as an Issue. Human validation never substitutes for machine QA.

## Automated Validation
This Slice owns the complete unit, integration and E2E test campaign. Include accessibility and visual-reference validation. Capture outcomes for both unit and E2E before acceptance.

## Acceptance Criteria
All three Mission screens present one coherent target-aligned UI; existing mission lifecycle/review behaviors work; all visible statistics are truthful; accessibility and responsive checks pass; no task-caused regression remains.

## Documentation Updates
Synchronize canonical docs with any final read-model or interaction contract changes.

## Handoff Notes
Do not accept "close enough" based only on component existence; visual hierarchy and information grouping must be checked against the supplied screens.
