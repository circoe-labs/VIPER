# Slice 01 — Prospect sheet visual hierarchy

## Goal
Refactor the Profil surface toward the selected centered, aligned, airy visual direction while preserving real data contracts and editor behavior.

## Context
The reference image validates hierarchy/alignment/padding, not literal fields. Existing editor already has Profil/Suivi.

## Canonical Concepts
ProspectEditor, ProfileSummary, ProspectScoreCard, DataQualityCard, ProspectLinksCard.

## Scope
### In Scope
- Top identity/action area.
- Indicator strip for prospect score, completeness state and proximity score slots.
- Summary + primary coordinates near the top.
- Aligned cards/grid and responsive spacing.
- Preserve save/close/back-next/edit semantics.
### Out of Scope
- Scoring algorithms.
- Mission runtime.
- Full Suivi content redesign (Slice 06).

## Dependencies
### Hard `depends_on`
- 00: readiness and hot-file ownership.
### Soft `requires`
- Slice 02: completeness state contract. Fallback: fixture semantic state component.
- Slice 03: proximity score read model. Fallback: typed placeholder/fixture with loading/unavailable state.
- Slice 04: score refresh affordance. Fallback: callback/action slot hidden behind feature seam.
### Can Start With
Current ProspectEditor and existing score/link components.
### Produces
Reusable prospect-sheet layout primitives and stable indicator slots.
### Integration Checkpoint
Before 07, wire live contracts and remove fixtures.

## Implementation Steps
1. Extract/organize layout primitives rather than inflating `ProspectEditor.tsx`.
2. Implement clear header, indicator row, summary/contact row and aligned detail grid.
3. Keep editing actions near their sections and maintain dirty/error tab semantics.
4. Handle long names/company/roles and narrow widths.
5. Use design-system tokens/components; avoid one-off generated-image styling.

## Files Likely Touched
`frontend/src/prospects/*`, prospect CSS, possibly shared UI layout primitives.

## Architecture Constraints
Do not make backend-derived scores in frontend. Do not hardcode data from visual reference.

## Automated Validation
Typecheck/build and targeted component smoke/accessibility checks. Do not launch the full unit suite.

## Acceptance Criteria
- First viewport prioritizes indicators, summary and coordinates.
- Layout is aligned and visually coherent at desktop and narrow sizes.
- Profil/Suivi tabs and save/navigation behaviors remain intact.

## Documentation Updates
Update prospect-editor/design-system docs.

## Handoff Notes
Coordinate `ProspectEditor.tsx` ownership with Slice 06.
