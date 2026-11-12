# Implementation log

Reserved for implementation agents. Record durable execution notes, deviations, migrations, test evidence and follow-up decisions here.

## Slice 00 — readiness gate (2026-11-12, agent 0, host CLARICE)

**Lifecycle fallback:** no `docs/workflows/AGENT_TASK_LIFECYCLE.md` in repo. Used memory: base branch `main`, Drive to-do folder `1I9XZF7qxKc2qYy_GVFqZywX2IVOcCtKv`. Connector cannot move folders and no `current` folder exists, so the handoff stays in `to-do` until the Human moves it. Local mirror: `tasks/viper_mission_supervision_agent_telemetry/` (45 files). Branch `task/viper_mission_supervision_agent_telemetry` from `main`.

**Blind audit (before reading docs/):** Mission/MissionRun (`backend/app/models/missions.py`), AgentTask/AgentTaskResult (`agent_missions.py`), identity = `McpToken` (`mcp.py`), claim/lease(15 min)/heartbeat/submit in `services/agent_missions.py`, MCP JSON-RPC in `api/mcp.py`. Alembic head `0037`. Results already have global `confidence` + `evidence[{field,source,quote}]`; `build_proposal` normalises to review items. No session/activity-log model, no mission metrics endpoint, no chart lib, no i18n lib (French hard-coded in `labels.ts`). Frontend: React 19, TanStack Query, Vitest, Playwright; `ui/Tabs.tsx` exists; Mission page `missions/MissionDetailPage.tsx`, `agents/ReviewDialog.tsx`. Gate: `python scripts/verify.py`.

**Reconciliation:** handoff matches repo (head 0037, evidence shape, no session model). Corrections:
- Slice 03/architecture list `organization_id` on session/log. Repo convention (`OrganizationOwnedMixin`): only root tables carry it; child rows inherit from parent. Sessions/logs inherit via mission; no own `organization_id` column unless a query need is proven.
- Migration number: next after head at implementation time (currently 0038).
- Charts: none exist; Slice 09 must build on the hand-rolled `ContactChart` approach or justify a dependency.
- `/caveman`, `/coding-guideline`, `/impeccable` skills are available.
- Dependency graph in TODO.md differs slightly from metadata.json (e.g. 02 is a dep of 05; 04 deps) — metadata.json deps are authoritative and all resolve to existing Slice IDs.

**Task Types:** all `metadata.json` have `task_type: null`; no Workspace Task Type vocabulary found in repo or skills. Per Slice 00, no Slice may be dispatched without a valid type.

**State: `HUMAN_DECISION_REQUIRED`** — need the Task Type vocabulary (or explicit waiver) before dispatching Slice 01.

**Human decision (2026-11-12):** Task Types waived ("on s en branle du TaskType"). State -> READY. Dispatch order: 01 -> 02,03 -> 04 -> 05 -> 06 -> 07,08,09 -> 10.

## Slice 01 — telemetry contract (2026-11-12)

Doc only. New canonical contract `doc/architecture/mission-telemetry.md`; links added in `missions.md` (§7b), `agent-missions.md` (§8 + open question 3), `mcp-server.md` (§3.7).

Decisions:
- **Sweep:** `MissionScheduler.run_once` calls `mission_telemetry.sweep_timed_out` after `run_due`, same transaction. `agent_missions.sweep_expired` and the 15-min lease untouched. Timeout = `ended_at = last_seen_at + 3h`, `timed_out` / `inactivity_timeout`, one `warning` log, audit `mission_agent_session.timed_out`.
- **Auto-open:** get-or-open in claim's transaction (partial unique index `(run_id, agent_id) WHERE status='active'`); touch on claim/heartbeat/log/submit/fail/release; touch after end/timeout opens a new session. No register/log-off.
- **Read policy:** org users see all agents' sessions/logs of the mission by default (filters available); MCP agents write own-session only (derived from task_id+claim_id) and have no cross-agent read.
- **Pagination:** activity = cursor (`before`, `next_cursor`, UUIDv7, like `history`); sessions/results = limit/offset with `total`.
- **MCP tools:** `viper_log_mission_activity`, optional `viper_end_mission_session`, `viper_get_mission_session`.
- **Evidence:** nullable `confidence` (int 0-100), `source_published_at`, `source_checked_at`, copied onto proposal items.
- Sessions/logs carry no `organization_id` (inherited via mission). Migration number = next after head at implementation time (0038 today).

Unresolved / for later slices: no time-based retention purge (deferred); append-only trigger must allow cascade delete from mission deletion (Slice 03 to design); `run_finished` / `mission_cancelled` session ends need hooks in `refresh_run` / `set_status`.

## Slice 02 — agent evidence contract (2026-11-12)

Implements `mission-telemetry.md` §9. `agent_payloads.py`: new `SourceFreshness` base (nullable `confidence` 0-100, `source_published_at` date|datetime, `source_checked_at` datetime; future published > now+1d and checked > now+5min refused); `Evidence` and `SignalProposal` inherit it. `build_proposal` copies `confidence`, `source_published_at`, `source_checked_at` (ISO strings, nulls when absent) next to `source`/`quote` on every item (company/employee field changes, emails, phones, created people, created companies, signals) via `evidence_item_fields`. `frontend/src/api/agents.ts` `ProposalItem` gets the three optional fields (types only). `missions.md` §6 updated. Tests: `backend/tests/test_agent_evidence_freshness.py` (old/new validation, bounds, future dates, extra still forbidden, proposal carries fields, never invents publication, historical rebuild).

Decisions / deviations:
- `SCHEMA_VERSION` not bumped: fields are additive and optional, old results validate unchanged.
- `date | datetime` union order on purpose: a bare date stays a date (pydantic smart union otherwise turns it into midnight datetime = invented time).
- Signals have no evidence list: the three fields sit directly on `SignalProposal`; item `quote` stays `score_reason` as before.
- No MCP schema/description change: submit tool does not describe evidence (Slice 04 owns guidance); JSON Schema published to agents picks the fields up from the model.
- `npm run lint` already fails on 33 pre-existing errors in untouched files; `typecheck` clean.
