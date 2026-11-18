# Slice 02 — Fiche completeness semantic state

## Goal
Replace the displayed numeric “Qualité de la fiche” score with a qualitative completeness state and explanation.

## Context
Current backend computes a deterministic 0–100 `DataQualityScore`. Product now wants an état de fiche, not a score.

## Canonical Concepts
`backend/app/services/prospect_data_quality.py`, `DataQualityCard`, prospect read model.

## Scope
### In Scope
- Define canonical semantic states and mapping from deterministic criteria.
- Expose state + summary + criterion breakdown; internal numeric may remain private if useful.
- Update UI to show state rather than ring/number.
### Out of Scope
- AI judgement of data quality.
- Prospect commercial-fit score.

## Dependencies
### Hard `depends_on`
- 00.
### Soft `requires`
- Slice 01 layout slot. Fallback: keep component API independent and render in current location.
### Can Start With
Current deterministic criteria and tests.
### Produces
Stable `ProfileCompletenessState` contract/UI.
### Integration Checkpoint
Wire into Slice 01 and final API compatibility before 07.

## Implementation Steps
1. Choose/configure states (minimum expected progression: incomplete → usable → rich → very rich) with explicit thresholds/criteria semantics.
2. Preserve deterministic explainability and opposition handling.
3. Add compatibility adapter if API consumers still need numeric value temporarily.
4. Replace visible 0–100 ring with state badge/summary and details.

## Files Likely Touched
Backend data-quality service/schema/routes, `frontend/src/api/prospects.ts`, `DataQualityCard.tsx`, score-view labels/CSS, docs/tests.

## Architecture Constraints
No LLM for completeness. Do not conflate completeness with commercial fit.

## Automated Validation
Targeted service/component checks + type/static checks. Do not launch full unit suites.

## Acceptance Criteria
- User sees a state, not a numeric “quality score”.
- Missing criteria remain understandable.
- Existing opposition/error states remain explicit.

## Documentation Updates
Dedicated contract in prospect-editor/data-model docs.

## Handoff Notes
If keeping numeric internal score, document it as implementation detail, not product vocabulary.
