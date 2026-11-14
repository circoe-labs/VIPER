# Slice 05 — Navigation and deep-link convergence
Hard depends 02,03,04; soft 01. Owns routes.tsx + shell navigation. Entity/filter selection in URL state; preserve bookmarks/redirects (/contacts-joignables, /prospection/companies, /exploitation...). Verify Home->Contact appointment, Home->Prospection entity/status, entity switching with Back/Forward. Freeze query params/destinations.

## Common (all slices)
Scope out: mission UI redesign, new global design system, merging IProspect/IContact/VIPER, fabricated stats. Reuse existing contracts. Coding slices: /caveman + /coding-guideline; frontend: /impeccable. Impl slices: review + targeted type/build/static + bounded smoke ONLY (no full unit suite; Slice 06 owns it). Never expose an invented metric: render unknown/unavailable or drop the card. Prefix commits with slice id. Document new/changed contracts in repo docs. Report collisions / dishonest-metric cases to PM.
