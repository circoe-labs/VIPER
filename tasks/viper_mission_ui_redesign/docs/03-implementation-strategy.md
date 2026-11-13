# Implementation strategy

## Dependency graph

```text
00 Project Manager readiness
        |
        v
01 Shared UI contract / source-of-truth mapping
   |             |             |
   v             v             v
02 Missions list 03 Statistics 04 Mission detail + review
   \             |             /
    \------------v------------/
              05 Integration/E2E
```

Numbering is presentation order, not a serial execution mandate.

## Initial dispatch
After Slice 00 reaches `READY`, dispatch Slice 01.
After Slice 01 publishes the shared contract, dispatch **02, 03 and 04 concurrently** when their file ownership remains disjoint.

## Hard chains
- `00 -> 01` because the shared visual contract must be reconciled against the current repository and target screens before independent surfaces diverge.
- `01 -> 02/03/04` because all three surfaces need one coherent density, typography, status/color, spacing and chart-language contract.
- `02 + 03 + 04 -> 05` because final visual/integration validation consumes all three.

## Soft requirements
Slices 02–04 require current API payloads and may start against existing hooks/fixtures. If one branch discovers a missing truthful field, it should publish the minimal read-model requirement and continue all independent UI work. The live field is mandatory before Slice 05.

## Hot-file risk
`MissionDetailPage.tsx`, shared UI primitives and `missions.css` can become collision points. Slice 01 should reduce this risk by establishing reusable primitives and new surface-specific stylesheets. PM may serialize a narrowly scoped shared-file patch without serializing entire slices.
