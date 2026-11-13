# Slice 01 — Visual source-of-truth mapping and shared Mission UI contract

## Goal
Translate the three supplied target screens into an implementation-ready Mission UI system mapped onto the current VIPER data/actions.

## Context
The target screens define visual composition; current repository behavior defines what the controls and numbers actually mean.

## Canonical Concepts
Mission status, run/task/result status, agent activity, human review, source-of-truth visual mapping.

## Scope
### In Scope
Inventory current components/data; annotate each target region with source hook/field/action; define shared spacing/type/card/status/chart rules; decide reusable Mission primitives; define responsive behavior; specify unknown/empty/loading/error states; establish pie/donut usage rules and accessible alternatives.
### Out of Scope
Rebuilding telemetry or business logic; implementing all three screens end to end.

## Dependencies
### Hard `depends_on`
- 00: repository/overlap readiness must be fresh before freezing shared UI assumptions.
### Soft `requires`
- Existing Mission API payloads and visual references. Fallback: current hooks/fixtures and explicit `unknown` states while mapping.
### Can Start With
Current MissionsPage/MissionDetailPage/ReviewDialog/Stats implementation and target screenshots.
### Produces
Shared visual contract, reusable primitive decisions, field/action mapping, hot-file ownership guidance for 02–04.
### Integration Checkpoint
02–04 must consume this contract before final live wiring; mismatches are resolved by adapting presentation, not inventing duplicate domain concepts.

## Implementation Steps
1. Load `/caveman`, `/coding-guideline`, and `/impeccable`; use the host frontend routing rule.
2. Compare every target region with current components and actual API fields.
3. Document what is retained, moved, consolidated, removed from prominence, or visually transformed.
4. Create/update only shared primitives/tokens needed by multiple surfaces.
5. Prefer surface-specific stylesheets thereafter to minimize merge collisions.
6. Define chart semantics and accessibility contract.
7. Perform code review and focused build/type/static checks; do not run the full unit suite.

## Files Likely Touched
Shared Mission UI primitives/tokens, `frontend/src/missions/*` shared components, possibly a narrowly scoped shared stylesheet; docs if component contract is canonical.

## Architecture Constraints
No new domain model. No fake metrics. Frontend work requires `/impeccable`; coding requires `/caveman` and `/coding-guideline`.

## Automated Validation
Static/type/build check and visual smoke of shared primitives. Do not launch the unit test suite at this Slice boundary.

## Acceptance Criteria
A fresh agent can implement any of the three target screens without guessing where each displayed fact/action comes from or independently inventing styling semantics.

## Documentation Updates
Persist the visual/data mapping in canonical frontend documentation if the repository has an appropriate design-system location.

## Handoff Notes
Publish exact hot files before dispatching 02–04.
