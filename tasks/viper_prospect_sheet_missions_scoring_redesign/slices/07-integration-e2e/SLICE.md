# Slice 07 — Integration, migration and final QA/E2E

## Goal
Converge all branches into one coherent prospect-sheet experience and prove the product contracts end to end.

## Context
This is the only full testing convergence Slice.

## Scope
### In Scope
- Live wiring of all score/state/menu contracts.
- Resolve migration/API compatibility.
- Full unit + integration + E2E campaign.
- Final responsive/accessibility/runtime validation.
### Out of Scope
- New product features beyond fixing integration regressions.

## Dependencies
### Hard `depends_on`
- 01, 02, 03, 04, 05, 06: all product outcomes are consumed here.
### Soft `requires`
None.
### Can Start With
All completed implementation branches.
### Produces
Integrated accepted implementation and evidence.
### Integration Checkpoint
This Slice is the convergence checkpoint.

## Implementation Steps
1. Reconcile shared types/API/read models and remove fixtures/adapters no longer needed.
2. Verify only one proximity score contract exists across overlapping tasks.
3. Verify visual hierarchy on Profil and Suivi.
4. Verify mission presets, custom microphone path and prospect target binding.
5. Verify reassessment mission trace and score refresh behavior.
6. Verify completeness state replaces visible numeric quality score.
7. Run full backend/frontend unit suites and integration/E2E in the same final validation phase; parallelize only if environment isolation is safe.
8. Attribute failures to responsible Slice, fix, run targeted checks, then repeat impacted final gates.

## Files Likely Touched
Integration seams and E2E/tests/docs only unless regressions require owner fixes.

## Architecture Constraints
No known regression may be accepted as an Issue.

## Automated Validation
This Slice alone owns the full unit, integration and E2E suites.

## Acceptance Criteria
- User sees commercial-fit score, semantic fiche state and separate proximity score at top.
- Profil and Suivi are visually coherent and responsive.
- Mission menu creates correct prospect-scoped missions for all presets/custom objective.
- Microphone has usable fallback/error handling.
- Contact context action is accessible.
- Score reassessment is explainable and traceable.
- No graph proximity leaks into prospect commercial-fit score.
- All complete test suites pass.

## Documentation Updates
Update canonical feature docs, decision log and migration/runbook where needed.

## Handoff Notes
Human validation should compare the integrated product to the selected visual for hierarchy/spacing, not pixel identity.
