# Implementation strategy

1. Freeze the telemetry/evidence contracts in documentation before persistence/UI work.
2. Extend result evidence contract in a backward-compatible way; old stored results without new fields must remain reviewable.
3. Add session/log persistence with migration and concurrency constraints.
4. Integrate session lifecycle into existing claim/heartbeat flow, then expose explicit MCP log/session tools.
5. Add mission supervision APIs and aggregate queries.
6. Convert Mission detail to a tabbed shell while preserving existing actions/configuration.
7. Implement Activity and Results tabs against the new APIs.
8. Redesign ReviewDialog after the normalized proposal contract contains the metadata it needs.
9. Add Statistics last, using event/result/task data rather than bespoke counters where possible.
10. Run integration, accessibility, concurrency and trace validation before completion.

## Migration constraints
- Use the next Alembic migration after repository head at implementation time; do not assume the current observed head (`0037`) remains current.
- Backward-compatible nullable evidence fields are required for historical results.
- Session/log migrations must not change existing task/result semantics.
- Large log queries need indexes on mission/run/session/time and pagination from the first version.

## Rollout safety
The tabs can ship progressively if hidden behind the same Mission detail route, but the Project Manager must not expose an Activity/Statistics tab backed by fabricated data. Empty states are preferable to fake telemetry.
