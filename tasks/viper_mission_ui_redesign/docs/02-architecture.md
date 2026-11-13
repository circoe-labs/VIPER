# Architecture and reuse boundaries

## Existing execution spine

```text
Mission
  -> MissionRun
    -> AgentTask
      -> AgentTaskResult
```

Existing supervision adds mission-scoped sessions/activity logs and read endpoints. Existing review normalizes agent results and applies accepted changes only after a human decision.

## Frontend surfaces
- `frontend/src/missions/MissionsPage.tsx` — general Missions view.
- `frontend/src/missions/MissionDetailPage.tsx` — mission shell/header/actions/tab routing.
- Mission Activity/Results/Stats components under `frontend/src/missions/*`.
- `frontend/src/agents/ReviewDialog.tsx` and related review components — human validation.

## Design implementation rule
Slice 01 owns shared Mission visual primitives/tokens and the exact layout contract. Slices 02–04 should prefer surface-specific component and stylesheet files. Avoid parallel edits to the same monolithic `missions.css`; if shared CSS must change after Slice 01, PM coordinates ownership or serializes only that hot-file change.

## Backend boundary
Use existing `/api/missions` detail/supervision/statistics endpoints and current hooks first. A backend change is allowed only if a visual requires a fact that is already legitimately observable but not exposed. No new persistence model should be introduced for presentation-only convenience.

## Statistics semantics
Potential metrics, contingent on existing data:
- mission run/task counts and states;
- result counts and review states (waiting/accepted/rejected/error);
- active/recent agent sessions;
- activity/log event counts and time buckets;
- per-agent share of activity/results;
- tool/API-call counts only when the telemetry contract records them as factual events/counters;
- durations/latencies only where timestamps support them without guesswork;
- error/timeout/warning incidence.

Unsupported metrics render as unavailable/omitted, not zero unless zero is semantically proven.
