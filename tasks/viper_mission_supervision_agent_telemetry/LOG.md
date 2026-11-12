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


## Slice 03 — session and log persistence (2026-11-12)

Implemented the contract of `doc/architecture/mission-telemetry.md` §3-§5, no deviation.

- Migration `0038_mission_telemetry` (+ downgrade): tables `mission_agent_sessions`, `mission_agent_logs`, partial unique index `uq_mission_agent_sessions_active (run_id, agent_id) WHERE status='active'`, sweep index on active `last_seen_at`, stream indexes `(mission_id|run_id|session_id, created_at DESC, id DESC)`, `set_updated_at` trigger on sessions, CHECKs (`active` <=> no end/reason, message length, `source_url` http(s)). No `organization_id` on either table (inherited via mission).
- Append-only: trigger function `mission_agent_logs_guard()`. UPDATE and TRUNCATE rejected; DELETE passes only when the log's mission, run or session row is already gone (FK cascade; the parent is deleted before the RI trigger reaches the child); the only UPDATE that passes is the `task_id` SET NULL of a deleted task (all other columns unchanged).
- Models `MissionAgentSession`, `MissionAgentLog` (`app/models/mission_telemetry.py`, exported), enums `MissionAgentSessionStatus`, `MissionAgentDisconnectReason`, `MissionAgentLogEvent`. Python attribute `details` maps to column `metadata`.
- Service `app/services/mission_telemetry.py`: `touch_session` (get-or-open via `INSERT .. ON CONFLICT (run_id, agent_id) WHERE status='active' DO UPDATE last_seen_at = GREATEST`), `end_session`, `end_run_sessions`, `sweep_timed_out` (3 h, `FOR UPDATE SKIP LOCKED`, `ended_at = last_seen_at + 3 h`, warning log, audit), `append_log` (closed event types, 1000-char message, no HTML, http(s) URL, future `source_published_at` refused, metadata 4 KB / depth 3 / 500-char strings / forbidden reasoning keys), `list_logs` (cursor, org-scoped), `list_sessions` (offset, org-scoped).
- Integration: `agent_missions.claim`, `claim_specific`, `heartbeat`, `submit`, `fail`, `release` touch the session in the same transaction (lease logic, `DEFAULT_LEASE`, `sweep_expired` untouched); new `agent_missions.log_activity` (claim-checked log write, for Slice 04). `missions.refresh_run` ends sessions with `run_finished` when a run turns done; `missions.set_status(CANCELLED)` ends them with `mission_cancelled`. `MissionScheduler.run_once` calls `sweep_timed_out` after `run_due`, same transaction. Audit actions `mission_agent_session.opened|ended|timed_out`; both tables in `NOT_AUDITED_TABLES` with reason.
- Not done here (belongs to Slice 04): the 120 logs/min/token rate limit, the MCP tools.
- Tests: `backend/tests/test_mission_telemetry.py` (concurrent open with 8 threads on real commits, touch/end/reopen, run finished, mission cancelled, 3 h timeout, lease/timeout independence, validation matrix, append-only, task SET NULL, cascades on mission and run, org isolation, cursor and offset pagination, index use, scheduler pass). Run on a dedicated database (`viper_s3_test`) because another agent shares `viper_test`.
- Evidence (backend/, Docker Postgres): telemetry + agent_missions(+model) + mission_stop + agent_review + missions + mcp_missions = 146 passed; mcp*/audit*/agent_capabilities/agents_api = 164 passed, 1 failed; `test_migrations.py` 5 passed, 2 failed. The 3 failures are pre-existing and unrelated: `warehouse_drafts`/`warehouses` missing from `NOT_AUDITED_TABLES`, `warehouses` lacks the `set_updated_at` trigger, `fk_warehouse_drafts_warehouse_id_warehouses` has no index. The migration round trip and model/migration drift tests pass with 0038.
- Gates: `ruff check`/`ruff format --check` clean on all touched files (repo-wide ruff, `mypy tests` and the full suite have pre-existing failures in untouched warehouse/auth files); `mypy app` has only the pre-existing `warehouse_dispatch` import error.


## Slice 04 — MCP session and logging tools (2026-11-12)

Implements `mission-telemetry.md` §11 (+§5.6, §6, §10). No contract deviation.

- **Tools** (`backend/app/api/mcp_telemetry.py`, wired in `mcp.py`, capability `tasks.work`, `require()` first, call history via `_log_call`): `viper_log_mission_activity`, `viper_end_mission_session`, `viper_get_mission_session`. Inputs carry no session/run/mission/agent id; `agent_missions.log_activity` re-runs the `_claimed` checks (`not_allowed`, `conflict`, `task_cancelled`) and derives the session from task + token. End/get resolve the run from `task_id` and the session from the token; unknown task or no own session -> `not_found`. Annotations: writes non-destructive, get read-only.
- **Rate limit:** `mission_telemetry.check_log_rate` (120 logs / rolling 60 s / token, `rate_limited`, 429, `limit`, `window_seconds`). Counted in the DB (via the token's sessions seen in the window, so the small table + `(session_id, created_at)` index), not in memory: correct across API workers. Soft under concurrency (two simultaneous writes can both pass at 119). Checked after the claim check, before validation.
- **Guidance:** claim payload of a task with a `run_id` gets `telemetry` (`agent_payloads.TELEMETRY_GUIDANCE`: automatic session, 8 event types, facts-only rules, no personal data, one log per source, refused log non-fatal, factual research report in result `notes`). Descriptions of `viper_claim_task`, `viper_heartbeat_task`, `viper_submit_task_result` updated. No vocabulary of §6 anywhere (conformance test over tool names, properties, descriptions and the guidance). Thread (legacy) tasks get no `telemetry` block.
- **Docs:** `mcp-server.md` §3.9 telemetry tools section rewritten as shipped; `mission-telemetry.md` status; `agent-missions.md` §8 note.
- **Tests** `backend/tests/test_mcp_telemetry.py` (18) + `test_mcp.py` tools list: listing/annotations/no register tool, forbidden vocabulary, auto-session + guidance, thread task without guidance, log in own session + touch, spoofed ids ignored, capability_denied (3 tools), 401, wrong claim_id, other agent's task, cancelled mission, field caps/closed taxonomy matrix, rate limit (per token, window, history row), get read-only / end idempotent / reopen after end, own-session only, full flow + submit unchanged, trace.
- **Evidence** (DB `viper_s4_test`): `test_mcp*` + telemetry + agent_missions + mission_stop + missions + agent_review + evidence + capabilities + agents_api + audit + migrations: all pass except the 3 known pre-existing warehouse failures (`test_every_table_is_either_audited_or_explicitly_not`, `..._has_the_trigger`, `..._covered_by_a_full_index`). `ruff check/format` clean on touched files; `mypy app` only the `warehouse_dispatch` error.

### Agent trace (real `/mcp` endpoint, `test_agent_trace_claim_log_heartbeat_submit`, `VIPER_TRACE_OUT=file` dumps it)

Worker token "Agent trace", mission with one company. 10 JSON-RPC `tools/call` requests (session rows after each in brackets):

| # | Request | Response | Sessions / logs |
|---|---|---|---|
| 0 | `viper_claim_task {task_types:[update_company]}` | payload + `claim_id` + `telemetry` block | 1 active / 0 |
| 1 | `viper_log_mission_activity {task_id, claim_id, event_type:search, message, metadata:{engine:web}}` | `{log_id, session_id, created_at}` | 1 / 1 |
| 2 | same, `source_opened` + `source_url` | same session_id | 1 / 2 |
| 3 | same, `observation` + `source_url` | same | 1 / 3 |
| 4 | same, `verification` + `metadata:{field:siren, outcome:confirmed}` | same | 1 / 4 |
| 5 | `viper_heartbeat_task {task_id, claim_id}` | `{lease_expires_at}` (+15 min) | 1 / 4 |
| 6 | `viper_get_mission_session {task_id}` | `{status:active, started_at, last_seen_at (= heartbeat time), logs_count:4, ended_at:null}` | unchanged |
| 7 | log `progress` `{done:1,total:1}` | ok | 1 / 5 |
| 8 | `viper_submit_task_result {…, result:{legal_name, confidence, notes}}` | `{result_id, status:pending_review, summary}` | 1 active / 5 |
| 9 | `viper_end_mission_session {task_id}` | `{status:ended, ended_at}` | 1 ended / 5 |

All five logs share one `session_id`, created by the claim (no register call; audit `mission_agent_session.opened` by the agent). Submit left the session `active` (contract §3.3: submit is activity, not an end). Result stayed a proposal awaiting review.

Findings (agent-trace checklist: calls, errors, unnecessary calls, guidance, cost):
- No errors, no retries, no unknown-tool calls; every log landed in the right session, 1 call per fact.
- Unnecessary calls: none required. `viper_get_mission_session` (#6) and `viper_end_mission_session` (#9) are optional and the guidance does not push them (they are in the tool list only). A log does **not** renew the lease, so `viper_heartbeat_task` (#5) stays necessary; the description now says so (agents may otherwise believe frequent logging is enough, then lose the task at 15 min).
- Guidance cost: the `telemetry` block adds about 1.3 KB (~350 tokens) to each mission claim, one-off per task. Acceptable; could be shortened by dropping the per-type descriptions (the tool schema already lists the enum) if claim size becomes an issue.
- Guidance gap noted, not fixed: after submit, a late log is refused with `conflict` "The claim is lost: this task is no longer yours" (generic `_claimed` message). Correct and non-fatal, but a more specific message would help; left as is to keep `_claimed` semantics unchanged. `heartbeat_every_seconds: 300` (payload) vs 15-min lease is pre-existing.
- A real LLM agent was not run (no model in this environment): the trace scripts the calls an agent following the guidance would make. Compliance with "facts only, French, one per source" must still be reviewed on a real agent run (Slice 10).


## Slice 05 — mission supervision read APIs (2026-11-12)

Implements `mission-telemetry.md` §8. Frontend: Slices 06-09 code against the endpoints and the TypeScript types/hooks below (`frontend/src/api/missions.ts`, "Mission supervision" block; no UI).

**Code.** `backend/app/api/routes/mission_supervision.py` (router, Pydantic models, registered in `router.py`), `backend/app/services/mission_supervision.py` (overview / results / statistics; activity and sessions reuse `mission_telemetry.list_logs` / `list_sessions` from S3). No migration: the S3 indexes (`(mission_id, created_at DESC, id DESC)` on logs, `(mission_id, started_at)` on sessions) and the existing `agent_task_results.task_id` / `agent_tasks.run_id` indexes cover every query; `0039` was not needed.

**Rules common to all routes.** `GET` only, read-only (a test asserts no `last_seen_at` moves), signed-in session (401 otherwise). Organization scope: the mission must belong to the viewer's organization (`mission_supervision.visible_mission`), else `404 {"detail":{"code":"not_found"}}` (same answer as an unknown id). Same access level as the other mission routes (any signed-in member; the existing routes have no per-capability gate). Superadmin gets no cross-organization bypass here. Bad enum/limit/offset -> FastAPI `422`; bad `before` cursor and `days` out of range -> `422 {"code":"invalid","field":...}`. `GET /api/missions/{id}` is unchanged.

### Endpoint list

| Route | Query params | Pagination |
|---|---|---|
| `GET /api/missions/{id}/overview` | none | none |
| `GET /api/missions/{id}/sessions` | `run_id`, `status` (repeat: `active`,`ended`,`timed_out`), `agent_id`, `limit` 1-100 (25), `offset` >=0 | offset + `total` |
| `GET /api/missions/{id}/activity` | `run_id`, `session_id`, `agent_id`, `task_id`, `event_type` (repeat, 8 closed types), `since` (datetime), `before` (log id), `limit` 1-100 (50) | cursor `next_cursor`, newest first |
| `GET /api/missions/{id}/results` | `status` (repeat: `pending_review`,`accepted`,`rejected`,`superseded`), `agent_id`, `run_id`, `limit` 1-100 (25), `offset` >=0 | offset + `total`, `submitted_at` desc |
| `GET /api/missions/{id}/statistics` | `bucket` `day`\|`hour` (day), `days` 1-90 (14; max 7 with `hour`) | none |

The full result payload for the review dialog stays on the existing review endpoint (`result.id` is the key). Mission-wide results = results of tasks that belong to a run of the mission (tool-mode results without a run are never included).

**overview**
```json
{
  "mission_id": "0193...", "name": "Compléter les fiches", "status": "active", "next_run_at": null,
  "current_run": {"id": "0193...", "status": "running", "scheduled_at": "2026-11-10T09:00:00Z",
    "started_at": "2026-11-10T09:00:01Z", "finished_at": null, "tasks_total": 4, "results_count": 3},
  "active_sessions": 1, "active_agents": 1,
  "agents": [{"agent_id": "5f2c...", "agent_label": "Agent claude-01", "session_id": "0193...",
    "run_id": "0193...", "started_at": "2026-11-10T09:30:00Z", "last_seen_at": "2026-11-10T13:30:00Z"}],
  "last_activity_at": "2026-11-11T09:30:00Z",
  "tasks": {"total": 4, "finished": 3, "by_status": {"pending": 0, "claimed": 0, "submitted": 1, "accepted": 2, "failed": 1, "cancelled": 0}},
  "pending_reviews": 1,
  "warnings": [{"code": "sessions_timed_out", "message": "Des sessions d'agent ont expiré (3 h d'inactivité) dans la dernière exécution.", "count": 1}]
}
```
`current_run` = latest run by `scheduled_at` (null before the first run); `tasks.finished` = accepted + failed + cancelled (progress = finished / total). `last_activity_at` = max(session `last_seen_at`, newest log, newest result submission), null if none. `warnings[].code` in `sessions_timed_out` (timed-out sessions of the latest run), `tasks_failed` (failed tasks of the latest run), `no_active_agent` (run running, tasks waiting, no active session; count 0). Empty mission: zeros, `current_run: null`, `agents: []`, `warnings: []`, `last_activity_at: null`.

**sessions**
```json
{"items": [{"id": "0193...", "run_id": "0193...", "agent_id": "5f2c...", "agent_label": "Agent claude-01",
  "status": "timed_out", "started_at": "2026-11-10T09:30:00Z", "last_seen_at": "2026-11-10T10:00:00Z",
  "ended_at": "2026-11-10T13:00:00Z", "disconnect_reason": "inactivity_timeout", "logs_count": 12}],
 "total": 2, "limit": 25, "offset": 0}
```
`disconnect_reason`: null while active, else `agent_ended`, `run_finished`, `mission_cancelled`, `inactivity_timeout`.

**activity** (poll the first page, merge by `id`; older page = `before=<next_cursor>`)
```json
{"items": [{"id": "0193...", "session_id": "0193...", "run_id": "0193...", "task_id": "0193...",
  "agent_id": "5f2c...", "agent_label": "Agent claude-01", "session_status": "active",
  "event_type": "verification", "message": "SIREN confirmé sur le registre.",
  "source_url": "https://exemple.fr/a-propos", "source_published_at": null,
  "created_at": "2026-11-10T09:31:00Z", "metadata": {"field": "siren", "outcome": "confirmed"}}],
 "next_cursor": "0193..."}
```
`next_cursor` is null on the last page. `task_id` is null for the timeout warning and for logs of a deleted task.

**results**
```json
{"items": [{"id": "0193...", "task_id": "0193...", "run_id": "0193...", "task_type": "update_company",
  "status": "pending_review", "agent_id": "5f2c...", "agent_label": "Agent claude-01",
  "subject_label": "2SN", "summary": "Société confirmée sur deux sources.", "confidence": 88,
  "items_count": 4, "refused_count": 1, "sources_count": 2,
  "submitted_at": "2026-11-10T09:30:00Z", "decided_at": null, "decided_by": null}],
 "total": 3, "limit": 25, "offset": 0,
 "status_counts": {"pending_review": 1, "accepted": 1, "rejected": 1, "superseded": 0}}
```
`summary` = the agent's `notes` of the proposal (<= 280 chars, `…` when cut), null if none. `confidence` = the proposal's global confidence, falling back to the raw payload's, else null. `items_count`/`refused_count` = lengths of the proposal's `items`/`refused`; `sources_count` = distinct non-empty item `source` values. A historical result (before S2 evidence fields, or a staged-actions proposal) is read defensively: missing or malformed data gives null / 0, nothing is invented. `status_counts` ignores the `status` filter (tab badges) but honours `agent_id` and `run_id`.

**statistics** (`?bucket=day&days=14`)
```json
{"bucket": "day", "days": 14, "since": "2026-10-29T00:00:00Z", "until": "2026-11-12T10:00:00Z",
 "results_by_status": {"pending_review": 1, "accepted": 1, "rejected": 1, "superseded": 0},
 "tasks_by_status": {"pending": 0, "claimed": 0, "submitted": 1, "accepted": 2, "failed": 0, "cancelled": 0},
 "sessions_by_status": {"active": 2, "ended": 0, "timed_out": 0},
 "logs_by_event_type": {"search": 1, "source_opened": 1, "observation": 0, "verification": 0, "progress": 0, "warning": 1, "error": 0, "decision_summary": 0},
 "results_series": [{"bucket": "2026-11-10T00:00:00Z", "pending_review": 0, "accepted": 1, "rejected": 1, "superseded": 0}],
 "sessions_series": [{"bucket": "2026-11-10T00:00:00Z", "count": 2}],
 "logs_series": [{"bucket": "2026-11-10T00:00:00Z", "count": 3}],
 "decided_count": 2, "acceptance_rate": 0.5, "avg_review_seconds": 1200.0,
 "agents": [{"agent_id": "5f2c...", "agent_label": "Agent claude-01", "sessions": 1, "logs": 2, "results": 2, "accepted": 1, "rejected": 0, "pending_review": 1}]}
```
Totals (`*_by_status`, `logs_by_event_type`, `decided_count`, rates, `agents`) cover the whole mission; the three `*_series` cover the window and are zero-filled (one point per bucket, UTC boundaries; results by `submitted_at`, sessions by `started_at`, logs by `created_at`). `acceptance_rate` = accepted / (accepted + rejected), `avg_review_seconds` = mean(`decided_at` - `submitted_at`) of decided results; both null until a result is decided. Aggregation is SQL (`GROUP BY` + `date_trunc`); `agents` merges three grouped queries by `agent_id`, ordered by label.

### Run-finished caveat (S3) fixed
`run_finished` session ending only ran inside `refresh_run`, i.e. when the mission card was read. New `missions.refresh_open_runs` (locks `running` runs `SKIP LOCKED`, max 200, reuses `refresh_run` as the single derivation rule) is now called by `MissionScheduler.run_once` before the timeout sweep, same transaction: a run whose last task was reviewed/failed/cancelled turns `done` and ends its sessions within one scheduler pass (60 s) even if nobody opens the page. Contract unchanged (`run_finished`, system actor, audited).

### Tests and gates
- `backend/tests/test_mission_supervision.py` (27): 401 on all 5 routes; 404 on a foreign-organization mission and unknown id for all 5 routes; existing detail shape untouched; empty mission (zeros/nulls, empty series values); overview live state / progress / warnings / no-active-agent; overview query-count ceiling; sessions pagination + filters + `logs_count`; activity cursor + all filters + 422 on bad type/cursor; reads never touch a session; result cards (summary, confidence, counts, agent, decision); results pagination, filters, `status_counts`; no leak of other missions' or tool-mode results; historical/odd proposals read as unknown; summary truncation; statistics aggregates with seeded data (by-status, series, acceptance rate, average review time, per-agent); hourly buckets and bounds (422); scheduler pass ends sessions of a finished run.
- DB `viper_s5_test`. Targeted run (supervision, telemetry, missions, mission_stop, agent_missions, mcp, mcp_telemetry, mcp_missions, agent_review, audit, migrations): all pass except the 3 known pre-existing warehouse failures (`test_every_table_is_either_audited_or_explicitly_not`, `test_every_table_with_updated_at_has_the_trigger`, `test_every_foreign_key_is_covered_by_a_full_index`).
- `ruff check` / `ruff format --check` clean on touched files; `mypy app`: only the pre-existing `warehouse_dispatch` error. `npm run typecheck` clean (the pre-existing `missions.ts` is not prettier-clean at HEAD, so the new block was appended without reformatting the file).

### Deviations / risks
- `activity` of the slice text = the contract's two routes: sessions list is `/sessions`, logs are `/activity` (as `mission-telemetry.md` §8).
- No per-capability role check (consistent with existing mission routes, which only require a session); organization check is strict even for the superadmin.
- `last_activity_at` and `no_active_agent` treat session `last_seen_at`, logs and result submissions as "activity"; heartbeats show through `last_seen_at`.
- Results `agent_id` filter matches `submitted_by_id` (the MCP token id as a string); results from before token ids were recorded (null) cannot be filtered by agent.
- `results` summary is the proposal `notes` (the agent's research report text); there is no separate summary column.
- Statistics series use UTC day boundaries; the UI shows local time, so a day bucket can differ from the user's local day.


## Slice 06 — tabbed Mission shell and Overview feedback (2026-11-12)

Frontend only, no backend/contract change. Consumes the S5 `GET /api/missions/{id}/overview` via the existing `useMissionOverview` hook.

**Code (`frontend/src/missions/`).**
- `MissionDetailPage.tsx`: header, actions (Activer/Désactiver, Modifier, Supprimer), dialogs and the existing banners (paused, cannot run, last run failed) kept in the shell; body is now `MissionLiveStrip` + `ui/Tabs` (Vue d'ensemble / Activité / Résultats / Statistiques). Tab is URL-synced with `?tab=activity|results|stats` (overview = no param, unknown value falls back to overview; `replace` navigation so tab changes do not pile up history; reload and deep links work). Tabs a11y/keyboard come from `ui/Tabs` (roles, one tab stop, arrows/Home/End, panel labelled by tab).
- `MissionLiveStrip.tsx` (new): agents active now (+ first label), last activity (relative), progress `finished/total` with `<progress>`, pending-reviews badge (button jumping to Résultats), API warnings rendered verbatim (`sessions_timed_out`, `tasks_failed`, `no_active_agent`). States: loading, error with « Réessayer » (role=status, not alert: it is secondary, the page stays usable), empty before the first run (no figures), stale-after-error note. Polled every 15 s (`OVERVIEW_POLL_MS`); react-query does not refetch in a hidden browser tab (`refetchIntervalInBackground` default false), so polling is visible-tab only.
- `MissionOverviewTab.tsx` (new): consigne, linked data, runs list, tasks list and `ReviewDialog` opening (« Relire »), moved unchanged out of the page. There is no « Lancer maintenant » action in the existing page (the existing test asserts its absence); none added.
- `ActivityTab.tsx`, `ResultsTab.tsx`, `StatsTab.tsx`: placeholder panels with honest empty states, props `{ missionId }` only; Slices 07-09 replace the bodies without touching the shell. Résultats tab shows a count badge (overview `pending_reviews`, falling back to `card.results_pending` while the overview loads/fails).
- `labels.ts`: `MISSION_TABS`, `MISSION_TAB_LABELS`, `parseMissionTab`, `relativeMomentLabel`. `missions.css`: `.mission-live*`, `.mission-tab-count` (tokens only).
- Tests: `MissionTabs.test.tsx` (13: four tabs + badge, click + URL sync, arrows/Home/End, deep link, unknown tab fallback, badge jump, actions reachable on every tab, strip loading / live+warnings / no agent / empty / error+retry). Shared fixtures extracted to `missionTestData.ts` (used by `MissionsPage.test.tsx`, unchanged behaviour).

**Gates (frontend/).** `npm run typecheck` clean; `npm run build` OK; `npx eslint src/missions src/ui/Tabs.tsx` clean; `vitest run src/missions src/ui/Tabs.test.tsx`: 26 passed (existing mission page tests all pass). Full `npm test`: 14 failed / 1152 passed, all in untouched areas (agenda, companies, imports, prospection, AppShell, `tokens.test.ts` for `prospection/overview.css` and `warehouses/warehouses.css`), none in missions; not investigated (pre-existing, outside scope).

**Runtime evidence.** Dev DB (Docker `viper-db-1`) migrated 0037 -> 0038 (S5's 0039 not needed), backend `uvicorn` on 8042, the already-running Vite (5173, this checkout), Playwright chromium (Claude-in-Chrome extension was not connected). A throwaway user `s6-runtime@circoe.com` and one mission with `run_now` were created through the API, then deleted afterwards (user and mission removed, backend stopped). Observed on the real overview: strip shows « Aucun » agent, « Aucune pour l'instant », `0 / 1 tâche` and the real `no_active_agent` warning; tabs render; click -> `?tab=activity`; ArrowRight from Activité -> `?tab=results` with focus moved; reload keeps `?tab=results`; unauthenticated `/api/auth/session` 401 before login is the only HTTP error, no console errors or page errors. Live layout (2 agents, 3 pending reviews, timed-out warning, badge on Résultats) was screenshotted with the overview response **mocked in the browser** (layout check only; no live agent session was available). Screenshots (scratchpad): `overview.png`, `mobile.png`, `live-mocked.png`.

**Deviations / risks.** The existing page had no « Lancer maintenant »: nothing to preserve there. The app shell (fixed sidebar) is not responsive at 390 px and produces page-level horizontal scroll independent of this slice; inside the page the strip wraps and the tab list scrolls horizontally. The strip polls only the overview; Activité/Résultats/Statistiques tabs add their own queries in 07-09. Overview error uses `role="status"` so it does not collide with action-error alerts (delete failure) that tests and users rely on.


## Slice 07 — Activité tab (2026-11-12)

Frontend only, no backend/contract change. Consumes S5 `GET /sessions` and `GET /activity`.

**Code (`frontend/src/missions/`).** `ActivityTab.tsx` (container: sessions query polled 10 s, filters, relative-time clock), `ActivitySessions.tsx` (session cards), `ActivityLog.tsx` (entries, polled first page + one component per older cursor page), `activityLabels.ts` (French wording, tones, `safeSourceUrl`, `sourceDateLabel`), `activity.css` (tokens only). `api/missions.ts`: `useMissionSessions` gained an optional 3rd arg `liveMs` (additive).
- Sessions: agent label, status badge (En cours / Terminée / Expirée), started / last seen (relative, absolute in `title` + `<time>`), log count, disconnect reason; timed-out card carries a visible warning (« Session expirée : Aucune activité pendant 3 h. L'agent a été déconnecté avant d'avoir terminé. »). Several agents side by side. Polite live region only for the « N agents en cours sur M sessions » count.
- Log: type badge (8 types), agent, relative time, message, source link (http/https only; other schemes shown as text), « Publiée le … » only when the API gives a date, else « Date de publication inconnue » (never invented), « Journal de la tâche » button (task filter; the app has no task route to link to).
- Filters: agent, exécution, session (selects), event types (toggle buttons `aria-pressed`, multi), task chip, reset. Server-side via the S5 query params. Cursor « Charger les entrées plus anciennes »; entries already shown are dropped (polled first page shifts).
- States: loading, error + retry (sessions and log separately), empty (no agent yet / no entry yet / no match), stale-after-error note. No reasoning vocabulary (tested).
- Tests: `ActivityTab.test.tsx` (11): sessions + counts + times, timed-out warning, entries + source/date/unsafe URL, vocabulary, filters (types, agent, run, session, reset), task filter, load more + dedupe, empty, no match, error + retry, loading.
- Gates (frontend/): `npm run typecheck` clean; eslint on my files clean; `vitest run src/missions/ActivityTab.test.tsx`: 11 passed; `npm run build` OK. `MissionTabs.test.tsx` had 2 failures caused by Slices 08/09 replacing placeholders concurrently (not Activity).
- **Runtime** (dedicated DB `viper_s7_dev`, backend 8047, Vite 5197, Playwright chromium): migrated to 0038, user + mission/run/3 tasks and 3 sessions (active with 66 logs, timed_out, ended) seeded through `mission_telemetry.append_log` (service, not MCP). Observed: 3 cards side by side incl. timed-out warning, log newest first with source link + date « 4 mars 2026 », filter Erreur -> 1 entry, reset, load more 50 -> 66 entries, mobile 390 px layout. Console/HTTP: only the pre-login `/api/auth/session` 401. Screenshots (scratchpad): `s7-activity.png`, `s7-activity-more.png`, `s7-activity-mobile.png`. DB dropped, servers stopped.
- Deviations / risks: no « idle » state (contract has none; last-seen time shown). Session select/cards use the first 100 sessions (note shown if more). Filters are local state (not in the URL). Task link = log filter. Prettier is not configured in the repo; formatted with `--no-semi --single-quote --print-width 120`.
