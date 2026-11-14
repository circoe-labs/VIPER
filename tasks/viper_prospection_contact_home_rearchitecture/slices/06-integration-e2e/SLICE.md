# Slice 06 — Final integration, full tests, human-ready validation
Hard depends 01..05. Remove fixtures/provisional adapters; no simulated counter remains. Run full unit suite ONCE + integration + E2E. Flows: entity switching, weekly additions, Contact filters, Home deep-links, Back/Forward, editor/workbench. A11y + responsive sanity. Regressions are blocking; attribute to responsible slice.

## Common (all slices)
Scope out: mission UI redesign, new global design system, merging IProspect/IContact/VIPER, fabricated stats. Reuse existing contracts. Coding slices: /caveman + /coding-guideline; frontend: /impeccable. Impl slices: review + targeted type/build/static + bounded smoke ONLY (no full unit suite; Slice 06 owns it). Never expose an invented metric: render unknown/unavailable or drop the card. Prefix commits with slice id. Document new/changed contracts in repo docs. Report collisions / dishonest-metric cases to PM.
