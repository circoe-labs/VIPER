# Slice 00 — PM readiness (agent 0 only, never delegated)
Blind audit of Prospection/Contact/Home/routes/API/read models/tests/overlapping tasks; reconcile with handoff; emit READY|CONTEXT_REWORK_REQUIRED|CONFLICT|HUMAN_DECISION_REQUIRED; dispatch 01,02,03,04 if parallel-safe; no product code edits; no full unit suite.

## Common (all slices)
Scope out: mission UI redesign, new global design system, merging IProspect/IContact/VIPER, fabricated stats. Reuse existing contracts. Coding slices: /caveman + /coding-guideline; frontend: /impeccable. Impl slices: review + targeted type/build/static + bounded smoke ONLY (no full unit suite; Slice 06 owns it). Never expose an invented metric: render unknown/unavailable or drop the card. Prefix commits with slice id (S1..S6). Document new/changed contracts in repo docs. Report file collisions / dishonest-metric cases to PM.
