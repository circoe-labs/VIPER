# Reference « Appels API » widgets and per-agent task timeline have no telemetry source

The mission statistics reference shows API-call counts, calls per agent, calls per minute and a typed task timeline (Gantt). The telemetry has no tool/API-call counter (`doc/architecture/mission-telemetry.md` §5.2, §14), so the Statistiques tab shows journal entries, sessions, tasks and results instead (CONTRACT D3). Follow-up, if wanted: a product decision on logging MCP calls as a counted event type, then a statistics read-model extension.
