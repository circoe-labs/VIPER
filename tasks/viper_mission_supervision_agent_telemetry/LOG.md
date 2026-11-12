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
