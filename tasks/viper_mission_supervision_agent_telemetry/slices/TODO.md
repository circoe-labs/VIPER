# VIPER Mission supervision — Slice orchestration

## Status
`[ ]` not started · `[~]` in progress · `[x]` complete · `[-]` deferred with rationale

- [x] **00** `00-project-manager` — readiness audit, reconciliation and dispatch plan
- [x] **01** `01-telemetry-contract` — canonical session/log/research-report contract
- [x] **02** `02-agent-evidence-contract` — per-item confidence and source date metadata
- [x] **03** `03-session-log-persistence` — migration, models, lifecycle and timeout persistence
- [x] **04** `04-mcp-session-logging` — MCP tools, auto-session integration, agent guidance and traces
- [x] **05** `05-mission-supervision-api` — overview/activity/results/statistics read APIs
- [x] **06** `06-mission-tabs-overview` — tabbed Mission shell and compact Overview feedback
- [x] **07** `07-activity-tab` — live/recent agent activity UX
- [x] **08** `08-results-review-ux` — result cards + redesigned review dialog + reject-on-demand
- [x] **09** `09-statistics-tab` — activity/result metrics and chronological charts
- [ ] **10** `10-integration-hardening` — E2E, concurrency, accessibility, documentation and final QA

## Dependency graph
- 00 gates everything.
- 01 -> 02, 03.
- 02 -> 05, 08.
- 03 -> 04, 05.
- 04 -> 05, 07, 09.
- 05 -> 06, 07, 08, 09.
- 06 -> 07, 08, 09.
- 07 + 08 + 09 -> 10.

## Dispatch rule
Before each Slice, the Project Manager performs a targeted freshness check against the repository. Coding Slices require `/caveman` and `/coding-guideline`. Frontend Slices additionally require `/impeccable` and should be routed to a Claude agent when the host supports that rule.
