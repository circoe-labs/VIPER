# Implementation strategy

## Dependency graph

```text
00 PM readiness
  |
  +--> 01 Categories + skills foundation ----> 02 Source library/evidence ----> 05 Admin UI/navigation ----> 06 Voice authoring
  |
  +--> 03 Agent identity/lifecycle -------------------\
  |                                                    \
  +--> 04 Mission objective + output contract ---------------------> 07 Runtime convergence
                                                          \
05 + 06 ---------------------------------------------------> 08 Final integration/E2E
07 ---------------------------------------------------------> 08
```

Initial dispatch set after Slice 00: **01, 03, 04**.

## Main hard chains
- `01 -> 02 -> 05 -> 06 -> 08`
- `01 + 02 + 03 + 04 -> 07 -> 08`

## Soft requirements
- 05 may scaffold UI components against fixtures/read contracts while 02 is being finalized, but live admin wiring waits for 01+02.
- 07 consumes 05/06 surface contracts when available but can implement backend/runtime convergence independently against API fixtures; live UI wiring is reconciled before 08.

## Hot-file risks
- `backend/app/models/missions.py`, migrations, mission services: 01 and 02 must not edit concurrently; hence hard ordering.
- `frontend/src/missions/CreateMissionDialog.tsx`: 05 and 06 both need it; hence hard ordering.
- `frontend/src/shell/navigation.ts`, `routes.tsx`: 05 owns navigation changes. 06 should add only its dedicated voice component/route integration through the seam established by 05.
- `backend/app/api/mcp.py` and agent payload/runtime services: 03 and 04 should coordinate, not both rewrite claim dispatch architecture. 03 owns identity/lifecycle; 04 owns mission objective/completion plus payload/result contract. 07 reconciles any shared call-site edits.
- Existing Settings prompt surfaces/services are a shared seam: 01 owns the persisted mission-creator prompt contract/API, 05 owns its Settings UI, and 06 consumes it at runtime.
- Existing `MissionTarget` code is not to be overloaded blindly for internal context sources; 02 owns the distinction and 07 owns runtime resolution.

## Migration/rollout
- Preserve existing missions and existing `MissionType` runtime behavior during migration.
- Seed categories corresponding to existing enum values and backfill mission category references.
- Do not delete legacy source rows until compatibility/migration proves mission links retained.
- Feature-gate or compatibility-adapt voice authoring if speech/model dependencies are unavailable in deployment.
- Preserve existing recurrence fields/scheduler and backfill objective state without changing historical run meaning. Recurring run objectives must be snapshot-safe so later mission edits do not rewrite completed run history.
