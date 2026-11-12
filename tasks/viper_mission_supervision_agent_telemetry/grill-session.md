# Reconstructed planning session

> This is a faithful reconstruction of the project discussion, not a verbatim transcript.

The user reviewed the current VIPER Mission detail UI and judged the displayed information useful but the UX insufficiently intuitive. The main problems identified were:

- insufficient UI feedback about what agents are actively doing;
- a one-page layout that forces scrolling through mission details, executions and tasks;
- review actions hidden behind individual task rows;
- weak visibility into agent activity over time;
- a validation dialog with useful data but weak hierarchy and insufficient evidence detail.

Requested product changes:

1. Split Mission detail into multiple tabs while preserving a recap/summary tab.
2. Add a dedicated result tracking tab with compact result cards showing date, outcome/status, agent, number/type of fields changed or entities added, and direct click-to-review.
3. Add a Statistics tab with chronological activity, per-agent breakdowns, additions/corrections/entities, Added/Refused/Waiting counters, and activity/call style charts where applicable.
4. Redesign the review dialog to emphasize global confidence, show confidence per proposed row/item, source URL, source freshness/publication date where available, and remove the permanently visible rejection-reason field.
5. Add an agent research report/activity log showing factual steps, sources consulted and useful observations.
6. Give agents mission log read/write capabilities and strongly instruct them to log meaningful research activity.
7. Make mission/agent association explicit for better multi-agent management and statistics.
8. Automatically log off an agent after 3 hours without activity, with a warning.

Repository inspection established that VIPER already has:

- `Mission -> MissionRun -> AgentTask -> AgentTaskResult`;
- task `claimed_by_id`, `claimed_by_label`, `claimed_at`, `lease_expires_at`, `last_heartbeat_at`;
- MCP identity through `viper_whoami`;
- claim/heartbeat/submit/fail/release tools;
- `Evidence(field, source, quote)` plus a result-level `confidence`;
- the existing `ReviewDialog` and Mission detail page.

Planning conclusions:

- Do not invent a second identity/heartbeat architecture.
- Add `MissionAgentSession` and `MissionAgentLog` concepts, persisted in the database and scoped to mission/run/agent.
- Create sessions automatically when a mission task is claimed.
- Update session `last_seen_at` from existing heartbeat and mission-log activity.
- Keep an explicit mission-session end tool, but do not rely on it for correctness.
- Time out sessions after 3 hours of inactivity.
- Agent logs must be factual action/evidence summaries, not private reasoning traces.
- Extend evidence so review items can show per-item confidence plus source publication/freshness and checked-at timestamps.
- Build UI around four tabs: Overview, Activity, Results, Statistics.
