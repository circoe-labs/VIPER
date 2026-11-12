# Mission telemetry — agent sessions, activity logs and research report

> **Status: contrat de niveau 2 (Slice 01 du handoff `viper_mission_supervision_agent_telemetry`).**
> **Persistance implémentée (Slice 03)** : migration `0038`, modèles `MissionAgentSession` /
> `MissionAgentLog`, service `app/services/mission_telemetry.py` (`touch_session`, `end_session`,
> `end_run_sessions`, `sweep_timed_out`, `append_log`, `list_logs`, `list_sessions`),
> `agent_missions.log_activity`, balayage dans `MissionScheduler.run_once`. **Outils MCP livrés (Slice 04)** :
> `app/api/mcp_telemetry.py`, limite de 120 écritures/min/jeton (`check_log_rate`), consignes
> `telemetry` dans la charge utile du claim. **Routes de lecture livrées (Slice 05)** : `app/api/routes/mission_supervision.py`, service `app/services/mission_supervision.py`, exemples JSON dans le `LOG.md` du handoff. Ce document est la **source canonique** ; en cas de divergence
> avec les fiches de la tâche, il prévaut. Documentation technique en anglais, vocabulaire produit
> en français (comme les documents frères).

Companion of [`missions.md`](missions.md) (Mission → Run → Task → Result) and
[`agent-missions.md`](agent-missions.md) (claim, lease, heartbeat, review). VIPER stays the human
validation and control plane: telemetry **observes** agent work, it never decides, applies or
replaces a result. A result is still a proposal a person accepts in the review.

## 1. Why, and what this is not

The Mission page becomes a supervision console: « qui travaille sur cette mission, depuis quand, et
qu'a-t-il vérifié ? ». That needs two new kinds of rows next to the existing spine:

```
Mission
  └── MissionRun
        ├── AgentTask ── AgentTaskResult          (unchanged: execution + human review)
        └── MissionAgentSession (one per agent participation in the run)
              └── MissionAgentLog (append-only factual events)
```

This is **not**:

- a second identity system: the agent is the existing MCP token (`mcp_tokens.id`, label snapshotted),
  resolved from the authenticated call, never from a payload field;
- a second heartbeat: `viper_heartbeat_task` stays the only liveness call; it additionally *touches*
  the session (§3.3);
- a requirement on the model: **no register / log-off call exists or is needed** (§3.2). Session
  integrity never depends on an agent remembering to call anything;
- a place for reasoning: see §6.

## 2. Two clocks, never confused

| | Task lease | Session timeout |
|---|---|---|
| Question answered | « may this agent still hold the task ? » | « is this agent still active on the mission ? » |
| Duration | **15 minutes** (`agent_missions.DEFAULT_LEASE`), renewed by heartbeat | **3 hours** without mission activity (`SESSION_INACTIVITY_TIMEOUT`) |
| Effect when it runs out | the task returns to the queue (`agent_missions.sweep_expired`, `agent_task.expired`) | the session becomes `timed_out`; **no task is touched** |
| Owner | `agent_tasks.lease_expires_at` | `mission_agent_sessions.last_seen_at` |

The session timeout **never** extends, shortens, renews or releases a lease, and the lease expiry
never ends a session by itself. They are independent: a lease can expire (task back in the queue)
while the session stays `active` until 3 hours of silence; a session can be `ended` by the agent
while a task is still leased. `agent_missions.sweep_expired`, `DEFAULT_LEASE`, `heartbeat`, `claim`
semantics and their audit events are **unchanged** by this contract.

## 3. `MissionAgentSession`

One row per *participation* of one agent in one run. Table `mission_agent_sessions` (Slice 03).

### 3.1 Fields

| Column | Type | Notes |
|---|---|---|
| `id` | uuid | UUIDv7 (`UUIDPrimaryKeyMixin`) |
| `mission_id` | FK `missions` `CASCADE`, indexed | |
| `run_id` | FK `mission_runs` `CASCADE`, indexed | |
| `agent_id` | varchar | `McpToken.id` as string (the `claimed_by_id` convention: `agent_missions._agent_id`) |
| `agent_label` | varchar | label **snapshotted** at open, like `claimed_by_label` |
| `started_at` | timestamptz | |
| `last_seen_at` | timestamptz | last activity (§3.3); drives the timeout |
| `ended_at` | timestamptz, null | set when status leaves `active` |
| `status` | enum `mission_agent_session_status` | `active`, `ended`, `timed_out` |
| `disconnect_reason` | varchar, null | null while `active`; otherwise one value of §3.4 |
| timestamps | | `TimestampMixin` |

- **Ownership.** A session carries **no `organization_id`**: repository convention
  (`OrganizationOwnedMixin`) puts it on root tables only; children inherit it through their parent.
  The organization of a session is the organization of its `mission_id`; every query filters
  through the mission (a join, as `missions` routes already do). An own column is added only if a
  measured query need appears.
- **Counters.** None cached at first (`logs_count`, etc. are computed). Add them only if Slice 05
  measurement proves a need.
- **No `thread_id`.** Legacy « Analyse » threads (`agent_threads`, tool-mode `viper_update_*`) have
  no run and get no session; telemetry covers mission tasks only (`agent_tasks.run_id IS NOT NULL`).

### 3.2 Uniqueness and auto-open (no register)

- **One active session per `(run_id, agent_id)`**, enforced by the database, not by code alone:
  `UNIQUE (run_id, agent_id) WHERE status = 'active'` (partial unique index). Historical rows
  (`ended`, `timed_out`) are kept and unconstrained, so an agent may have several sessions in a run
  over time.
- **Auto-open on claim.** `agent_missions.claim` / `claim_specific`, **only when the task has a
  `run_id`**, call `mission_telemetry.touch_session(...)` in the claim's own transaction after the
  task is claimed. `touch_session` is *get-or-open*: it returns the active session of
  `(run_id, agent_id)` or inserts one (`status=active`, `started_at = last_seen_at = now`,
  `agent_label` = token label). Concurrent claims by the same agent converge on one row through
  `INSERT … ON CONFLICT (run_id, agent_id) WHERE status = 'active' DO UPDATE SET last_seen_at`
  (or select-then-insert guarded by the index and a retry on `IntegrityError`); the result is always
  exactly one active row.
- **Opening is part of the claim's transaction.** If the session insert fails, the claim fails with
  it: a claimed mission task without an active session must be impossible.
- **Reopen after end.** If the session was `ended` or `timed_out` and the agent later touches the
  run again (claim of another task, heartbeat or log write on a still-held task), `touch_session`
  opens a **new** session. The ended row is never reactivated.
- **No `register()`, no `log_off()`.** No tool opens a session, and none is required to close one.
  An agent that crashes, or simply never says goodbye, is closed by the timeout (§4). Anything
  documented elsewhere as « register » or « log off » is superseded by this section.

### 3.3 Touch rules

`last_seen_at = now` (only forward: `GREATEST(last_seen_at, now)`) on the active session of
`(run_id, agent_id)`, in the **same transaction** as the triggering call:

| Event | Touches ? |
|---|---|
| `claim` / `claim_specific` of a mission task | yes (and auto-opens) |
| `heartbeat` of a mission task | yes |
| a log write (§5) | yes |
| `submit`, `fail`, `release` of a mission task | yes (it is activity; they do not end the session) |
| read-only calls (`viper_task_queue`, `viper_whoami`, reads) | **no** |
| a human opening the Activity tab | **no** |

The heartbeat path gains one UPDATE; it gains no new tool, no new parameter and no new failure
mode: if no active session exists for a held task (ended explicitly, or timed out), the touch opens
a new one rather than refusing the heartbeat. Telemetry failures must not turn a valid lease call
into an error beyond a rolled-back transaction caused by a genuine database fault.

### 3.4 Statuses and `disconnect_reason`

```
        claim / touch                explicit end (§3.5)
 (none) ─────────────▶ active ───────────────────────▶ ended
                          │
                          │ 3 h without activity (§4)
                          └────────────────────────────▶ timed_out
```

| `status` | `disconnect_reason` | Set by |
|---|---|---|
| `active` | `NULL` | auto-open |
| `ended` | `agent_ended` | the agent's explicit end tool |
| `ended` | `run_finished` | the run reaches `done` (`refresh_run`) while the session is active |
| `ended` | `mission_cancelled` | the mission or run is cancelled (`missions.set_status`) |
| `timed_out` | `inactivity_timeout` | the sweep of §4 |

A deleted mission removes its sessions by FK cascade (§7). `ended` / `timed_out` are terminal.

### 3.5 Explicit end (optional)

An agent **may** end its session: it is a courtesy that makes the Activity tab accurate sooner,
never a correctness requirement. Ending sets `status=ended`, `ended_at=now`,
`disconnect_reason=agent_ended`, does **not** release or fail any task, and is idempotent (ending an
already-terminal session returns it unchanged). The agent can only end **its own** session (resolved
from its token, never from a client-supplied `session_id`).

## 4. Inactivity timeout (3 hours)

- **Constant.** `SESSION_INACTIVITY_TIMEOUT = timedelta(hours=3)` in
  `app/services/mission_telemetry.py`. Distinct from, and never derived from, `DEFAULT_LEASE`.
- **Predicate.** `status = 'active' AND last_seen_at < now - 3h`.
- **Sweep integration point (decided): the `MissionScheduler` pass.**
  `MissionScheduler.run_once` (`app/services/mission_scheduler.py`, one daemon thread, every 60 s,
  one transaction per pass, started with the API) calls
  `mission_telemetry.sweep_timed_out(session, now)` **after** `missions.run_due` and in the same
  unit of work. Reasons: the scheduler already owns the periodic « housekeeping on missions »
  transaction and is already started/stopped with the app and replaced by `None` in tests (tests
  call the function directly, like `run_due`); 60 s granularity is ample for a 3 h rule; and a
  dedicated maintenance service would add a second background thread for no benefit.
  Rejected alternatives: *piggy-backing on `agent_missions.sweep_expired`* (it runs inside
  `claim` and `_claim`, i.e. only when an agent polls — a session whose agents all stopped would
  never time out — and it would couple the 3 h rule to the 15 min lease path); *a new maintenance
  thread* (needless). `sweep_expired` is **not modified**.
- **Effect per timed-out session** (single transaction, rows locked `FOR UPDATE SKIP LOCKED` so two
  workers cannot double-process, and the status predicate makes re-running idempotent):
  1. `status = timed_out`, `disconnect_reason = inactivity_timeout`,
     `ended_at = last_seen_at + 3h` (deterministic, independent of sweep latency);
  2. one **`warning`** log in that session (§5), `task_id` null, message
     « Session expirée après 3 h d'inactivité. », `metadata = {"reason": "inactivity_timeout",
     "last_seen_at": <iso>, "timeout_seconds": 10800}`, `created_at = ended_at`;
  3. one audit event `mission_agent_session.timed_out` (actor `system`, §7).
- **What the sweep never does.** It does not touch `agent_tasks` (no release, no fail, no status
  or lease change), does not reject or alter any result, and does not pause the mission. A task still
  leased by that agent follows only the lease rules of §2.
- **Failure.** A sweep error is logged (`logger.exception`) by the scheduler's existing
  `try/except`, never raised to the API; the next pass retries the same rows.

## 5. `MissionAgentLog`

Append-only, structured, factual. Table `mission_agent_logs` (Slice 03). **Database rows, never
files or folders.**

### 5.1 Fields

| Column | Type | Notes |
|---|---|---|
| `id` | uuid | UUIDv7: time-ordered, also the **pagination cursor** (§8) |
| `session_id` | FK `mission_agent_sessions` `CASCADE`, indexed | |
| `mission_id` | FK `missions` `CASCADE`, indexed | denormalised for mission-wide queries |
| `run_id` | FK `mission_runs` `CASCADE`, indexed | idem |
| `task_id` | FK `agent_tasks` `SET NULL`, null | the task being worked, when there is one |
| `agent_id` | varchar | copied from the session; never client-supplied |
| `event_type` | enum `mission_agent_log_event` | §5.2 |
| `message` | text, ≤ 1000 chars | one factual sentence, plain text (no HTML, no markdown required) |
| `source_url` | varchar(2048), null | `http`/`https` only, same validator as result sources |
| `source_published_at` | timestamptz, null | §5.3 |
| `created_at` | timestamptz | server clock at insert; never agent-supplied |
| `metadata` | JSONB, default `{}` | §5.4 |

No `organization_id` (§3.1: inherited through `mission_id`). No `updated_at`: rows are immutable.

### 5.2 Event taxonomy (closed)

| `event_type` | Meaning (what happened, not what the agent thinks) | Typical fields |
|---|---|---|
| `search` | a query was run (web, registry…) | `message` = what was looked for; `metadata.query`, `metadata.engine`, `metadata.results_count` |
| `source_opened` | a source was opened/read | `source_url`, `source_published_at` if the page states it |
| `observation` | a fact read on a source | `message` = the fact; `source_url` |
| `verification` | a value was checked or cross-checked | `message`; `metadata.field`, `metadata.outcome` (`confirmed`, `contradicted`, `not_found`), `source_url` |
| `progress` | a step finished (« 7 sociétés sur 20 traitées ») | `metadata.done`, `metadata.total` |
| `warning` | something notable but not blocking (a blocked site, a skipped source, **the timeout**) | `metadata.reason` |
| `error` | something failed in the agent's work | `metadata.code` |
| `decision_summary` | a **short factual summary of a choice and its evidence** (« Société retenue : SIREN confirmé sur deux sources ») — never the reasoning that led to it (§6) | `message`, `source_url` |

The set is closed: an unknown `event_type` is refused (`422`, field `event_type`). Adding a type is a
contract change in this document first.

### 5.3 `source_published_at`

Nullable, and **never invented**. Set only when the source itself states a publication/update date
that the agent read. Unknown → `NULL`. It is not the retrieval date (that is `created_at` for a log,
and `source_checked_at` for evidence, §9), not the date of a signal (`observed_on`), and not
inferred from a URL, a sitemap or « about now ». A caller sending a value in the future
(> now + 1 day) is refused; a date older than the source can plausibly carry is accepted as sent.

### 5.4 `metadata` (JSONB)

Free-form **structured, factual** extras per event type (examples above). Contract: a JSON object,
serialised size ≤ 4 KB, no nested depth beyond 3, string values ≤ 500 chars, **no key named or
containing** `thought`, `thinking`, `reasoning`, `chain_of_thought`, `scratchpad`, `cot` (refused
with `422`, §6). Not indexed beyond what Slice 05 needs; not a substitute for the typed columns.

### 5.5 Append-only

- No application path updates or deletes a log row (no `PATCH`, no `DELETE`, no MCP tool for it).
  `mission_agent_logs` joins the audit-style protection of ADR-0002: Slice 03 adds a database
  trigger rejecting `UPDATE` and `TRUNCATE`, and rejecting `DELETE` except as the cascade of a
  deleted mission/run/session (§7). Implemented as `mission_agent_logs_guard()`: a `DELETE` passes
  only when the log's mission, run or session row no longer exists (the cascade's RI trigger runs
  after the parent is gone); the only `UPDATE` that passes is the `task_id` SET NULL of a deleted
  task (every other column unchanged). A correction is a *new* log, not an edit.
- A session's `warning` on timeout is itself an ordinary appended row (§4).

### 5.6 Write rule (MCP agents write **own session only**)

An agent writes a log through `viper_log_mission_activity` (§11) and only into **its own** session:

1. the call carries `task_id` + `claim_id`; the server validates them exactly as
   `agent_missions._claimed` does (same actor, same live claim, `task_cancelled` /
   `claim_lost` / lease-expired refusals unchanged) — logging is therefore only possible while the
   agent legitimately holds a mission task;
2. `run_id`, `mission_id`, `agent_id` and `session_id` are **derived server-side** from the task and
   the token (`touch_session` gets-or-opens the active session of `(task.run_id, token id)`); the
   client can never name a session, a run or another agent;
3. `task_id` of the log is the claimed task;
4. the write touches the session (§3.3) in the same transaction.

Justification: an agent logging into another agent's session, or into a run it holds nothing in,
would falsify the supervision picture and is a prompt-injection channel (everything an agent sends
is data, `agent-missions.md` §13). Deriving the session from the claim makes a forged
`session_id` impossible by construction. Log writing is a **non-business write**: it needs no human
capability beyond the token's existing task scope, and it is not an audited business change (§7).

**Limits.** Server-side validation like every agent payload: field lengths of §5.1, URL scheme,
no HTML, rejected payload names the fields. Rate limit: at most **120 log writes per minute per
token** (same family as the claims-per-minute limit); beyond it the call is refused (`rate_limited`)
and the agent keeps working. A log failure must never fail the task: agents treat a refused log as
non-fatal.

## 6. Prohibition of chain-of-thought capture

Telemetry records **what the agent did and what it found**, never **why it thought so**.

- **Forbidden:** requesting, prompting for, accepting, storing or displaying private reasoning,
  hidden thoughts, scratchpads, step-by-step deliberation, « pourquoi j'ai choisi… » narratives, or
  a model's raw thinking blocks — in `message`, `metadata`, tool descriptions, agent guidance or UI
  copy.
- **Allowed:** actions (`search`, `source_opened`), observed facts with their source (`observation`),
  checks and their outcome (`verification`), progress, warnings/errors, and a *short factual
  `decision_summary`* that states the outcome and the evidence, not the deliberation.
- **Tool design.** `viper_log_mission_activity`'s description and schema never ask the agent to
  explain itself; they ask for what it did or found. No field is called `reasoning`, `thoughts`,
  `rationale`.
- **Enforcement.** (a) schema: closed `event_type` and the forbidden `metadata` key names (§5.4,
  `422`); (b) length caps that make dumping a monologue impractical (`message` ≤ 1000); (c) agent
  guidance reviewed in Slice 04; (d) a conformance test asserting no tool property or description
  matches the forbidden vocabulary. Server-side content classification of prose is **not**
  attempted (unreliable); the contract prevents the capture channel instead.

## 7. Authorization, read policy, retention, audit

### 7.1 Read policy (decided: shared across the run)

| Reader | Sees |
|---|---|
| Organization user (session auth) with access to the mission | **all** sessions and logs of **all agents of every run of that mission** by default; optional filters `run_id`, `session_id`, `agent_id`, `task_id`, `event_type` |
| MCP agent | **no read tool for logs or other agents' sessions.** At most its own session's status (§11) |

Why shared by default: the purpose is supervision of **concurrent** agents (decision 7 of the
decision log); a person reviewing a result needs the whole picture (« l'agent B a déjà vérifié cette
source »), and a default of « mine only » is meaningless for a human, who has no session of their
own. Logs carry no secret and no reasoning (§6) — only factual actions and public sources — and are
exposed to the same people who already read the results of that mission. The `agent_id` / `session_id`
filters give the narrowed view when wanted. Why agents cannot read: `agent-missions.md` §13
isolation (« no tool lists other agents' results ») and prompt-injection hygiene (another agent's
free text must not enter a model's context).

Organization scoping and role checks follow the existing mission routes (the mission's organization
via `OrganizationOwnedMixin`, same capability as reading a mission: `missions.read`). Read endpoints
never mutate and never touch a session (§3.3).

### 7.2 Audit

Three tiers, to keep `audit_log` small (ADR-0006: « no infinite event taxonomy ») while the
supervision data stays complete:

- **Session lifecycle is audited** (`audit_log`, new actions registered in `AuditAction` in Slice
  03): `mission_agent_session.opened` (actor = the agent), `.ended` (actor = the agent, or `system`
  for `run_finished` / `mission_cancelled`), `.timed_out` (actor `system`, id `sessions`). Subject
  = the mission. Payload: status, `disconnect_reason`, agent label — no log content.
- **Log rows are not duplicated into `audit_log`.** `mission_agent_logs` is its own append-only
  table; it must be listed in the audit test's `NOT_AUDITED_TABLES` with that reason (own append-only
  telemetry, high volume). `mission_agent_sessions` is audited through the actions above.
- **Results stay audited as today** (`agent_task.*`, `agent_task_result.*`); telemetry does not
  alter them.

### 7.3 Retention

- Sessions and logs are kept **as long as their mission exists** and are removed **only** by the
  cascade of deleting the mission (`DELETE /api/missions/{id}`, `missions.md` §7) or its run. Deleting
  a mission is the one sanctioned way telemetry disappears; the audit events of §7.2 outlive it
  (audit has no foreign keys).
- **No purge job in this contract.** A time-based retention for logs is explicitly **deferred**
  (same family as the open retention question for `raw`/`proposal`, `agent-missions.md` §13); until
  decided, nothing deletes telemetry.
- Logs may contain public-source URLs and short facts about companies or named people: the same
  personal-data care as results applies. Guidance to agents (Slice 04): log the fact and the source,
  do not paste e-mails/phones/free-text profiles beyond what the result itself will carry. Telemetry
  is never an alternative store of personal data.

## 8. Read API contract (implemented in Slice 05)

Conventions matched from the repository: routes under `/api/missions/{mission_id}/…`
(`missions.md` §7); list payloads `{ items: [...], … }`; **offset pagination** for bounded
list/aggregate views (`limit` / `offset` with `total`, as `companies`, `prospection`, `contact`,
`sequences`, `explorer`) and **cursor pagination** for time-ordered streams (`next_cursor` as a
UUIDv7 id, as `history`, `audit.history`). A log stream grows continuously and is polled live, so
it uses the cursor form; offset would skip or repeat rows as new ones arrive.

| Route | Purpose | Pagination |
|---|---|---|
| `GET /api/missions/{id}/overview` | compact live state: status, active sessions count, last activity, pending results | none |
| `GET /api/missions/{id}/sessions` | sessions of the mission; filters `run_id`, `status` (repeatable), `agent_id`; ordered `started_at` desc | `limit` (1–100, default 25) + `offset` (≥ 0); `{items, total, limit, offset}` |
| `GET /api/missions/{id}/activity` | the log stream; filters `run_id`, `session_id`, `agent_id`, `task_id`, `event_type` (repeatable), `since` (datetime) | cursor: `limit` (1–100, default 50) + `before` (log id, older page) ; `{items, next_cursor}`, newest first (`created_at`, then `id`, descending) |
| `GET /api/missions/{id}/results` | review queue cards | `limit`/`offset`, `{items, total, limit, offset}` (Slice 05) |
| `GET /api/missions/{id}/statistics` | aggregate counters and time buckets | none |

- `overview` and `results` shapes (Slice 05): `overview` = status, latest run, `active_sessions`/`active_agents` + live `agents`, `last_activity_at`, `tasks{total,finished,by_status}`, `pending_reviews`, `warnings[]` (`sessions_timed_out`, `tasks_failed`, `no_active_agent`); `results` cards = summary (proposal notes), global `confidence`, `items_count`, `refused_count`, `sources_count`, status, agent, dates, plus `status_counts`; `statistics` takes `bucket=day|hour` and `days` (1–90, 7 max hourly). A run that finished ends its sessions in the scheduler pass (`missions.refresh_open_runs`), not only when the card is read.
- **Live refresh.** A client polls the first page of `activity` (no `before`) and merges by `id`;
  no websocket is introduced.
- An activity item carries the log fields of §5.1 plus `agent_label` and `session_status`, so the UI
  never reconstructs them from raw JSON. Session items carry §3.1 plus computed `logs_count`.
- Every route is read-only, organization-scoped through the mission, returns `404` for a mission of
  another organization, and uses the existing `send_error_response` envelope.
- Unknown `event_type` / bad `status` filter → `422` naming the field.

## 9. Evidence extension contract (implemented in Slice 02)

Today (`agent_payloads.Evidence`): `{field, source, quote}` with a single result-level
`confidence` (int 0–100). Extended, **backward compatible**:

| Field | Type | Rule |
|---|---|---|
| `confidence` | int 0–100, **nullable** | per-evidence/item confidence, same scale and meaning as the result's global `confidence` |
| `source_published_at` | datetime/date, **nullable** | §5.3: the source's own stated date; never invented; `NULL` = unknown |
| `source_checked_at` | datetime, **nullable** | when the agent actually opened/verified the source; **distinct** from publication; set by the agent from its clock at the time of the check |

- All three are optional with default `NULL`: payloads, stored `raw` and proposals created before the
  extension stay valid and are read as « unknown ». `extra="forbid"` stays; the three names become
  declared fields. No migration of existing rows.
- `source_checked_at` in the future (> now + 5 min) is refused; `source_published_at` in the future
  is refused (§5.3). Dates keep their timezone; a bare date is accepted for `source_published_at`.
- **Normalisation.** `build_proposal` copies the three values onto the **review items** (field
  changes, created items, signals — each item carries `confidence`, `source`,
  `source_published_at`, `source_checked_at`, plus the existing `quote`), so the review UI reads
  them from the proposal and never from `raw`. An item without evidence carries `null`s and the card
  states « inconnue »; the result-level `confidence` remains the global figure.
- **Signals** keep their own `observed_on` (event date) and `valid_until`; neither is a substitute
  for `source_published_at` (publication of the source) or `source_checked_at`.
- The human review remains the only path that applies a proposal; none of these fields influences
  application.

## 10. Research report policy

Decision 6: every agent working a mission produces a **factual** research/activity report.

- **What it is.** The report is the agent's `MissionAgentLog` stream for its session(s) **plus** the
  per-item evidence of its result (§9), presented together on the Activity and Results tabs. There is
  no separate free-form « report » field and no new report table. The existing `AgentTaskResult`
  fields (`summary`-style text of the result schema) stay as they are.
- **Content (allowed).** What was searched; which sources were opened (URL, publication date if
  stated, check date); what was observed and where; which values were verified, confirmed or
  contradicted; what could not be found or was blocked; progress; and a short outcome summary per
  decision (`decision_summary`).
- **Not allowed.** Chain-of-thought (§6); guesses presented as findings; dates, sources, figures or
  quotes not actually read (never invent `source_published_at`); marketing prose or recommendations
  to the human to accept; personal data beyond the result's own scope (§7.3); instructions addressed
  to the reader or to another agent.
- **Tone and form.** Past tense, one fact per log, plain text, French for user-visible `message`
  text (product language) unless quoting a source.
- **Minimum.** A task worked by an agent should leave at least one `progress` or `verification` /
  `observation` log per source consulted. The minimum is guidance enforced by Slice 04 agent
  instructions and trace review; the server does not refuse a `submit` for lack of logs (a result is
  never blocked by telemetry).

## 11. MCP surface (implemented in Slice 04, `mcp-server.md` §3.9)

Existing tools (`viper_claim_task`, `viper_heartbeat_task`, `viper_submit_task_result`,
`viper_fail_task`, `viper_release_task`) keep their names, parameters and results unchanged; they
gain only the server-side session touch of §3.3. **New tools**, named by the `viper_` convention,
with the same bearer token, actor (Mode A: the agent), scope checks and call history as the other
task tools (`mcp-server.md` §3.7):

| Tool | Params | Result | Notes |
|---|---|---|---|
| `viper_log_mission_activity` | `task_id`, `claim_id`, `event_type`, `message`, optional `source_url`, `source_published_at`, `metadata` | `{ log_id, session_id, created_at }` | **the** log write (§5.6). Required to be a held, uncancelled mission task. Non-business write |
| `viper_end_mission_session` | `task_id` (a mission task of the agent in the run; need not still be claimed) | `{ session_id, status, ended_at }` | **optional** (§3.5): ends the caller's own active session of that task's run; idempotent; `not_found` if the agent has no session in that run |
| `viper_get_mission_session` | `task_id` | `{ session_id, status, started_at, last_seen_at, ended_at, disconnect_reason, logs_count }` | **optional**, read-only, own session only; lets an agent see that it was timed out. Does **not** touch the session |

There is deliberately **no** `viper_register_*`, `viper_start_mission_session`, `viper_logoff` or
any tool that opens a session (§3.2), and **no** tool to read logs of other agents (§7.1). Refusals
reuse the stable codes already documented in `mcp-server.md` §3.7 (`task_cancelled`, `claim_lost`,
`capability_denied`, `422` field errors) plus `rate_limited` (§5.6). All three tools declare
`readOnlyHint` accordingly (`viper_get_mission_session` read-only; the other two non-destructive
writes). Tool descriptions follow §6 and §10.

## 12. Acceptance checklist for the implementing Slices

- 02: evidence fields of §9 declared nullable; `build_proposal` copies them onto items; old payloads
  still validate (regression test).
- 03: migration (next after head at implementation time, currently `0038`) creating both tables,
  enums, the partial unique index of §3.2 and the log append-only trigger; `mission_telemetry`
  service (`touch_session`, `end_session`, `sweep_timed_out`, `log`); claim/heartbeat/submit/fail/
  release touch; `MissionScheduler.run_once` calls the sweep; `run_finished` / `mission_cancelled`
  ends; audit actions; concurrency test for one active session per `(run_id, agent_id)`; test that
  `sweep_expired` and leases are unchanged.
- 04: the three tools of §11, schema and description conformance (§6), auto-session through the
  claim, rate limit, agent guidance and a real agent trace.
- 05: the routes and pagination shapes of §8.
