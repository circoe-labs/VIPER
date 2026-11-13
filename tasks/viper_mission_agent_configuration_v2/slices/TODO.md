# Async Slice graph

Slice numbering is for identification/readability, **not** a serial execution mandate.

| Slice | Title | Hard dependencies |
|---|---|---|
| 00 | Project Manager readiness | none |
| 01 | Mission categories + instruction-skill foundation | 00 READY |
| 02 | External source library + internal context + evidence effectiveness | 01 |
| 03 | Agent identity, numbering and lifecycle | 00 READY |
| 04 | Mission objective + structured output contract | 00 READY |
| 05 | Admin UI, grouped navigation and mission category UX | 01, 02 |
| 06 | Voice/conversational mission authoring | 05 |
| 07 | Mission runtime convergence | 01, 02, 03, 04 |
| 08 | Final integration, unit/E2E and agent traces | 05, 06, 07 |

## Initial ready set after Slice 00
**01 + 03 + 04**, concurrently when the PM freshness audit confirms no new hot-file collision.

## Major unlocks
- 01 unlocks 02.
- 02 plus 01 unlock 05.
- 05 unlocks 06.
- 01+02+03+04 unlock 07.
- 05+06+07 unlock 08.

## Final convergence
Slice 08 is the only broad test campaign and final product acceptance convergence.
