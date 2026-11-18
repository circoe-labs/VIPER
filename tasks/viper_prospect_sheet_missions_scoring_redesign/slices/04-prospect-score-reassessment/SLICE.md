# Slice 04 — Prospect score semantics and agent reassessment

## Goal
Make Prospect Score explicitly represent commercial fit and add a traceable “Réévaluer le score” action using a VIPER agent/mission.

## Context
Current score is computed from manual prospect-note deltas and company signal deltas. Product now defines it as “à quel point on aimerait l'avoir comme client / à quel point il rentre dans les critères”.

## Canonical Concepts
`prospect_score.py`, prospect score card, Missions runtime/results.

## Scope
### In Scope
- Canonicalize commercial-fit-only scoring semantics.
- Audit current contributions and remove/avoid graph-derived influence.
- Add UI action (button/menu/context action) to request reassessment.
- Create one-off prospect-scoped mission/agent analysis producing structured, explainable proposed score evidence.
- Refresh score only through an auditable accepted/applied path.
### Out of Scope
- Proximity score.
- Automatic outbound actions.

## Dependencies
### Hard `depends_on`
- 00.
### Soft `requires`
- Slice 05 mission helper/UI. Fallback: implement a backend/domain command seam plus callback interface and wire later.
- Existing mission category/skill conventions. Fallback: use canonical `OTHER`/appropriate category only after PM audit, not a new parallel runtime.
### Can Start With
Current score service and mission target/result contracts.
### Produces
Commercial-fit contract + reassessment action/result path.
### Integration Checkpoint
Before 07, reassessment must create/run a real mission or canonical agent action and return traceable evidence.

## Implementation Steps
1. Document forbidden/allowed score inputs.
2. Define structured reassessment output: suggested score/contributions, rationale, source refs, timestamp/model/agent provenance.
3. Map reassessment to one-off mission targeted at current prospect.
4. Add card affordance and loading/success/failure state.
5. Ensure accepted output updates canonical scoring inputs or persisted assessment according to existing architecture; never silently overwrite without trace.

## Files Likely Touched
Prospect score service/schema/API, mission output/category/skill integration, ProspectScoreCard/API, docs/tests.

## Architecture Constraints
No proximity contribution. No unaudited direct LLM call. Keep score explainable.

## Automated Validation
Targeted service/API checks, genuine agent/mission trace in QA environment when available, UI smoke. Do not run full suites.

## Acceptance Criteria
- Score meaning is commercial fit only.
- User can request reassessment from the score area.
- Reassessment is prospect-bound, explainable and traceable.
- Failure does not destroy current score.

## Documentation Updates
Score contract and mission-result semantics.

## Handoff Notes
If score formula requires a product criteria matrix not present in repo, preserve the existing score while adding reassessment proposal and escalate only the missing weights—not the whole Slice.
