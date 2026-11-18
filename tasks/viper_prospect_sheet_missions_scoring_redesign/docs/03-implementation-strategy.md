# Implementation strategy

## Dependency graph

```text
00 PM readiness
 |-- 01 Prospect sheet layout -------------------\
 |-- 02 Completeness-state contract --------------\
 |-- 03 Proximity-score contract ------------------+--> 07 Integration / final QA
 |-- 04 Prospect-score reassessment --------------/
 |-- 05 Prospect Mission menu --------------------/
 \-- 06 Suivi-tab reflow ------------------------/
```

Numbers are identifiers, not a serial execution order.

## Initial ready set
After Slice 00 = READY: **01, 02, 03, 04, 05, 06**.

## Soft coordination seams
- Slice 01 requires the semantic outputs from 02/03/04 but can build against fixture types/placeholder components.
- Slice 03 requires the existing graph-scoring handoff status; if it is active/landed, adapt to its canonical contract. If not, implement only one canonical proximity service in this task and mark the older overlapping slice superseded during PM reconciliation.
- Slice 04 may reuse the mission creation capability from 05, but can first implement a service/command seam and fixture mission creation contract.
- Slice 06 should reuse the same visual tokens/layout primitives from 01; coordinate file ownership before concurrent edits to `ProspectEditor.tsx` and `prospects.css`.

## Hot-file risks
Likely shared hotspots:
- `frontend/src/prospects/ProspectEditor.tsx`
- `frontend/src/prospects/prospects.css`
- `frontend/src/api/prospects.ts`
- backend prospect read model/routes.

PM should assign 01 as owner of top-level layout shell and 06 as owner of Suivi child composition, or merge their edits through a deliberate integration branch/seam.
