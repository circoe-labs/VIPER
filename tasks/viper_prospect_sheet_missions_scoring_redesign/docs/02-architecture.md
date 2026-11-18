# Target architecture

## UI composition
`ProspectEditor` remains the orchestrating surface. Refactor presentation into stable blocks rather than replacing the editor lifecycle:
- Header/identity/action strip.
- Indicator strip: `ProspectScore`, `ProfileCompletenessState`, `ProximityScore`.
- Summary and primary coordinates.
- Aligned detail cards.
- Profil/Suivi tab contents.
- Footer save/navigation semantics preserved.

## Score prospect
Canonical meaning: commercial fit/desirability for Circoe based on prospect/company criteria and validated business signals. The contract remains explainable (`total`, summary, contributions/evidence), but contributions must not include graph proximity.

Re-evaluation should be modelled as a one-off prospect-scoped mission/agent analysis that returns a structured proposal/evidence. The acceptance/application path must reuse existing mission result review or a similarly auditable mechanism; avoid a fire-and-forget LLM endpoint.

## Fiche completeness
The backend may retain the current deterministic point calculation as an internal implementation detail, but the public/display contract must expose a semantic state and explanation, e.g.:
- `incomplete`
- `usable`
- `rich`
- `very_rich`

Exact thresholds are product/config decisions. UI shows the label and missing/strong dimensions, not a circular numeric score.

## Proximity score
A distinct 0–100 read model derived from person-link graph data. It should summarize the best path(s) from Circoe members to the prospect and expose explainability fields such as shortest/best path, aggregate strength and path count. Prefer an existing/canonical path-scoring contract from `viper_prospect_intelligence_graph_scoring_followups` if available.

## Mission menu
Use current mission creation APIs/models. The prospect is the target, not merely free-text context. Presets map to mission/category/skill/prompt choices without bypassing canonical mission validation. `Autre` adds a free-text objective; microphone uses the current speech-input abstraction.

## Contact context menu
A React context menu on the prospect surface may expose `Contacter`. It must have keyboard/button parity and reuse existing contact workflow/deep-link rather than creating a second contact flow.
