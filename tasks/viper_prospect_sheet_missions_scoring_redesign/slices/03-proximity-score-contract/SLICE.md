# Slice 03 — Graph proximity score

## Goal
Expose a distinct explainable 0–100 proximity score measuring how directly Circoe can reach the prospect through the relationship graph.

## Context
VIPER already has person links with 0–100 strength and an existing queued handoff for path-based reachability scoring.

## Canonical Concepts
`person_links`, graph API, `ProspectLinksCard`, queued handoff `viper_prospect_intelligence_graph_scoring_followups`.

## Scope
### In Scope
- Resolve/reuse canonical path-scoring algorithm.
- Read model for a prospect's proximity score and explanation.
- UI card/indicator slot data contract.
- Explain best path(s), relevant Circoe member(s), path strength/distance.
### Out of Scope
- Modifying commercial-fit score with graph data.
- Rebuilding graph visualization.

## Dependencies
### Hard `depends_on`
- 00.
### Soft `requires`
- Existing graph-scoring handoff: need its canonical contract/status. Fallback: inspect it and implement behind a single adapter/interface; do not create a second public score type.
- Slice 01 slot. Fallback: standalone component/API contract.
### Can Start With
Current person-link graph and fixtures.
### Produces
Canonical proximity score service/read model + frontend type/component.
### Integration Checkpoint
Before merge, PM must confirm there is exactly one canonical proximity/path scoring implementation across overlapping tasks.

## Implementation Steps
1. Audit overlapping handoff/branch status.
2. Adopt its algorithm if landed/active; otherwise define one explainable path metric using edge strength, hop penalty and multiple-path evidence.
3. Return 0–100 plus explanation and best path metadata.
4. Add loading/empty/unreachable/error states.
5. Make graph edits invalidate/recompute proximity reads.

## Files Likely Touched
`backend/app/services/person_links.py` or a dedicated proximity service, links/prospect routes, frontend prospect/API components, docs/tests.

## Architecture Constraints
Score proximity is separate from `ProspectScore`. No hidden LLM judgement.

## Automated Validation
Targeted graph/path fixtures, API smoke, component checks. Do not launch full suite.

## Acceptance Criteria
- Score reflects reachability from Circoe members.
- Multiple/strong/short relationships can improve proximity in an explainable way.
- No graph contribution enters commercial-fit score.

## Documentation Updates
Canonical scoring formula/contract and provenance/explainability.

## Handoff Notes
If overlap cannot be safely reconciled, return `CONFLICT` to PM rather than shipping parallel algorithms.
