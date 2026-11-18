# Async Slice graph

Numbering is for identity/readability, not mandatory serial execution.

| Slice | Title | Hard depends_on |
|---|---|---|
| 00 | Project Manager readiness | — |
| 01 | Prospect sheet visual hierarchy | 00 |
| 02 | Fiche completeness semantic state | 00 |
| 03 | Graph proximity score | 00 |
| 04 | Prospect score semantics + agent reassessment | 00 |
| 05 | Prospect-scoped Mission menu + context action | 00 |
| 06 | Suivi tab reflow | 00 |
| 07 | Integration, migration, full QA/E2E | 01,02,03,04,05,06 |

Initial ready set after READY: **01, 02, 03, 04, 05, 06**.

Major unlock: completion of all six implementation branches unlocks 07. Soft requirements are documented in each SLICE.md and must not be converted into false hard dependencies.
