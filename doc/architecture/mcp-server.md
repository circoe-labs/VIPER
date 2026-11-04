# VIPER as an MCP server — tool catalogue

> **Status: implemented — 29 tools** (`app.api.mcp.TOOLS`, checked 2026-11-04 at the end of the
> ChatGPT handoff, `tasks/viper_chatgpt_conversational/FINAL_TOOLS.md`):
>
> - transport, OAuth, tokens, call history and agent capabilities (§4, `viper_whoami` §4.7),
>   who may see and revoke an agent (§4.8);
> - the six task tools of §3.7 (`viper_claim_task` … `viper_task_queue`);
> - the basic tool mode of §3.2 and the two `update` proposals of §3.4 (`viper_list_companies`,
>   `viper_get_company`, `viper_list_prospects`, `viper_get_prospect`, `viper_update_company`,
>   `viper_update_prospect`);
> - the conversational reads of §3.9 (eight tools);
> - the mission actions of §3.10 (six tools) and the mission card of §3.12 (`resources/*`);
> - the contact draft tools of §3.11 (`viper_generate_contact_draft`,
>   `viper_update_contact_draft`) — the « draft door » of §4.3;
> - discovery of sites and a dated trigger is not a tool: it is the `find_prospects` result shape
>   (`establishments`, `trigger`; `agent-missions.md`), worked through the task tools.
>
> The other rows of the §3.1–3.5 tables (`viper_overview`, `viper_get_reference_data`,
> `viper_find_prospects`, the create/note/contactability/appointment writes, message transitions)
> remain proposals; §5 says which. Product names in French, code and technical documentation in
> English.

## 1. Starting point

- The backend exposes **98 HTTP handlers** under `/api` (`backend/app/api/routes/`), all protected
  by a **session cookie + CSRF header** (`app/api/dependencies.py: require_session`). This transport
  is unusable as-is for a machine client: no cookie, and `POST` would be refused for a missing CSRF
  token.
- VIPER already **speaks MCP as a client** (`app/services/toolbox/mcp_client.py`, JSON-RPC 2.0 over
  Streamable HTTP, `initialize` → `tools/call`). The protocol plumbing, error classification and
  timeouts are known; only the server side is new.
- The codebase **already anticipates an agent actor**: `ActorType.AGENT` and `AuditSource.AGENT`
  exist (`app/core/actor.py`, `app/services/audit.py`), and `AuditContext.on_behalf_of` is
  documented as *"the human who started or approved an automated actor's work (import, future
  agent)"*.
- But the domain invariants are **already enforced in the service layer**, not in the UI:

  | Guard | Where | Effect on MCP |
  |---|---|---|
  | "A contact state is chosen by a person, never by an agent." | `services/contact_tracking.py:84` | any tracking write by `AGENT` is refused |
  | "Only a person changes a contact state." | `services/prospect_editor.py:782` | `PATCH …/tracking` is human-only |
  | "A Contact message is handled by a person." | `services/contact_messages.py` (`_require_human`, `require_author`) | `save_message`, `save_generated`, `validate`, `schedule`, `mark_sent`, `schedule_cohorts` are human-only — except the draft door of §3.11 (`allow_agent`) |
  | "AI drafting is started by a person." | `services/contact_mail_generation.py` (`prepare`) | `generate` is human-only — except the draft door of §3.11 |
  | "A cohort is created and dated by a person." | `services/cohorts.py:67`, `contact_sequences.py:391` | cohort creation and change are human-only |
  | Settings/taxonomies writes | `services/app_settings.py:36` | human-only |
  | Quality alerts raise/resolve | `services/quality_alerts.py:181` | human-only |

  This is the crux: **the most valuable MCP write (writing a mail draft) is exactly the one the
  code refuses to an agent today.** The catalogue below therefore separates tools that work with
  `ActorType.AGENT` from tools that require a product decision (§5).

## 2. Rules used to cut the catalogue

1. **A tool is a user intent, not an endpoint.** One tool may join several handlers
   (`viper_find_prospects` = counters + list) and one handler may back no tool (`GET /auth/session`).
2. **Read by default; writes are explicit, versioned and attributable.** Every write carries the
   `version` / `expected_revision` the domain already uses for optimistic concurrency, and is
   audited with its own actor.
3. **The agent never crosses a line the code already drew.** If a service raises
   `ActorNotAllowedError` for `AGENT`, the tool is either absent or explicitly marked as needing
   the "on behalf of a person" mode.
4. **No secrets, no destruction, no bulk outbound.** Integrations keys, database reset, mass
   imports and scheduled sends are out, whatever the mode.
5. **An answer must be self-sufficient.** Labels next to ids, `version` next to content, and
   pagination metadata — no follow-up call just to interpret a result.

## 3. Catalogue

Legend — **kind**: `R` read, `W` write. **Actor**: `A` works with `ActorType.AGENT` today,
`H` requires a person (§5). **Phase**: 1 = MVP, 2 = after the identity decision, 3 = later/optional.

### 3.1 Context and reference data

| Tool | Intent | Backing endpoints | Kind | Actor | Phase |
|---|---|---|---|---|---|
| `viper_overview` | The state of the base: segment counts, the month's activity, the week to contact, last changes | `GET /home`, `GET /prospection/overview` | R | – | 1 |
| `viper_get_reference_data` | Ids and labels needed to filter: roles, activity categories, segments, referents, cohorts, contact settings (`max_follow_ups`) | `GET /settings/{taxonomy}`, `/settings/referents`, `/settings/cohorts`, `/settings/contact` | R | – | 1 |
| `viper_list_activity` | Recent audited changes (who, when, what), filterable by period | `GET /audit/recent` | R | – | 2 |

Rationale for `viper_get_reference_data`: every list tool takes taxonomy **ids**; without them an
agent cannot build a single filter. It is cacheable and cheap. It is one tool, not six, because an
agent needs all of them at once to plan a query.

### 3.2 Search and read — people and companies

| Tool | Intent | Backing endpoints | Kind | Actor | Phase |
|---|---|---|---|---|---|
| `viper_search` | Global multi-type lookup (prospect, company, establishment) with match quality (`exact`/`prefix`/`contains`) | `GET /search` | R | – | 1 |
| `viper_find_prospects` | The reference read: one page of people under the Prospection filters, **plus the segment counters** so the agent sees the shape of the base before paging | `GET /prospection/counters`, `GET /prospection/prospects` | R | – | 1 |
| `viper_get_prospect` | The full record: identity, company, role, channels, verification state, contactability, tracking, score, `version`; optionally the sequence (see `viper_get_outreach`) | `GET /prospects/{id}` | R | – | 1 |
| `viper_get_prospect_history` | The readable history of one person (edits, imports, state changes) | `GET /prospects/{id}/history` | R | – | 2 |
| `viper_get_company` | The company record with establishments, prospects and similar companies (`include_similar`) | `GET /companies/{id}`, `/similar` | R | – | 1 |

**Shipped (tool mode):** the basic lookups — `viper_list_companies` (`search`, page),
`viper_get_company` (with establishments and its people), `viper_list_prospects` (by
`company_ids` and/or name) and `viper_get_prospect` (full record, verification state, score). They
reuse `companies.list_companies`, `companies.get_company` and `prospect_editor.get_view`, so an
agent sees the labels a person sees; the Circoe-internal commercial columns stay out of
`viper_get_company`. `viper_search` shipped with the conversational reads (§3.9);
`viper_find_prospects` (the segment lens) and `viper_get_prospect_history` remain proposals.

Notes:
- `viper_find_prospects` returns `counters` + `items` + `total`, and never more than the
  `LIST_MAX_LIMIT` = 200 already enforced by the domain.
- There is **no generic "all prospects" list** in VIPER: a person is always read through the
  Prospection lens (segments) or the Contact lens (weeks/levels). The MCP must not invent a third
  one; that is why `viper_find_prospects` keeps the segment vocabulary.

### 3.3 Contact — reading the pipeline

| Tool | Intent | Backing endpoints | Kind | Actor | Phase |
|---|---|---|---|---|---|
| `viper_get_contact_plan` | "What must go out, and what is late": the weekly planning by category (`to_send`, `in_sequence`, `email_error`, `finished`, `disqualified`, …), by rank/level/cohort, with counters and the forgotten ones | `GET /contact/dashboard`, `/contact/scheduling`, `/contact/prospects` | R | – | 1 |
| `viper_get_outreach` | Where one person stands: cohort, level, next step, next due date, open sequence, real sends, the mail of every step, quality alerts | `GET /prospects/{id}/sequences`, `GET /prospects/{id}/messages`, `GET /alerts` | R | – | 1 |
| `viper_get_message` | One step's message alone (draft, validated, scheduled, sent) with its `revision` and AI provenance — for a targeted re-read before a write | `GET /prospects/{id}/messages/{step}` | R | – | 2 |

`viper_get_contact_plan` and `viper_find_prospects` both list people, but they answer different
questions ("who do I contact this week" vs. "who is in the base and what is missing"). Merging them
would produce a tool with two incompatible sorts and two sets of counters.

### 3.4 Writes that work with an agent actor today

| Tool | Intent | Backing endpoint | Kind | Actor | Phase |
|---|---|---|---|---|---|
| `viper_create_prospect` | Create a person (identity, company, role, channels, mandatory provenance) | `POST /prospects` | W | A | 2 |
| `viper_update_prospect` | Replace a person's record (`version` required; full alias lists) | `PUT /prospects/{id}` | W | A | 2 |
| `viper_set_contactability` | Set or lift the durable "Ne pas contacter" opposition, with a mandatory reason both ways | `PUT /prospects/{id}/contactability` | W | A | 2 |
| `viper_add_note` | Append a dated note (optional source and score delta) | `POST /prospects/{id}/notes` | W | A | 2 |
| `viper_create_company` | Create a company (needed before `viper_create_prospect` when the employer is new) | `POST /companies` | W | A | 2 |
| `viper_update_company` | Update a company (`version` required) | `PUT /companies/{id}` | W | A | 2 |
| `viper_list_appointments` | Appointments over a period | `GET /agenda/appointments` | R | – | 2 |
| `viper_save_appointment` | Create or move an appointment | `POST /agenda/appointments`, `PATCH /agenda/appointments/{id}` | W | A | 2 |

**Shipped (tool mode):** `viper_update_company` and `viper_update_prospect`. They are not direct
writes: the agent posts the same JSON as a mission result, VIPER opens (or reuses) the company's
thread, creates the matching task, claims it for the calling agent and stores the result as
`pending_review` — the ordinary « Agents » review card applies it when a person accepts. A token's
task scope still bounds them (`update_company` / `update_employee`). The create tools
(`viper_create_company`, `viper_create_prospect`) keep waiting for the `find_*` result schemas of
`agent-missions.md` §5.

### 3.5 Writes that require a decision (see §5)

| Tool | Intent | Backing endpoint | Blocked by |
|---|---|---|---|
| ~~`viper_save_message_draft`~~ | Shipped as `viper_update_contact_draft` (§3.11), restricted to a new message or a `draft` | `PUT /prospects/{id}/messages/{step}` | – |
| `viper_validate_message` | Human validation of the current revision | `POST …/validate` | idem — **should probably stay out even in mode B** |
| `viper_schedule_message` | Give a validated message its send moment | `POST …/schedule` | idem |
| `viper_mark_message_sent` | Declare a send that happened outside VIPER | `POST …/mark-sent` | idem |
| `viper_set_tracking_status` | Choose the commercial state (`neutral`, `response_received`, `appointment_obtained`, `ignored`, `disqualified`) | `PATCH /prospects/{id}/tracking` | `prospect_editor.py:782`, `contact_tracking.py:84` |
| `viper_set_cohort` | Put a person in a cohort (restarts the counter, cancels unsent mail) | `PUT /prospects/{id}/cohort` | `contact_sequences.py:391` |
| `viper_raise_alert` / `viper_resolve_alert` | Quality signal on a record | `POST /alerts`, `POST /alerts/{id}/resolve` | `quality_alerts.py:181` |

`viper_save_message_draft` is the single most valuable tool of the whole catalogue — it is what
"drive VIPER from an assistant" means in practice. It is also the one the code refused to an agent.
It shipped (§3.11) without passing a human actor: the agent stays the actor, and the service opens
only the draft half of the state machine to it.

### 3.7 Missions — the asynchronous mode

The catalogue above is **pull**: the assistant decides what to do, call by call. The brief of
2026-10-29 adds a second mode where **VIPER decides**: it cuts a company into tasks, hands them out
to agents that poll, and keeps the results as proposals a person validates. Six tools, specified
in [`agent-missions.md`](agent-missions.md):

| Tool | Intent |
|---|---|
| `viper_claim_task` | Claim the next task matching the token's scopes; returns the payload (subject, missing fields, sources, `output_schema`) |
| `viper_heartbeat_task` | Renew the lease |
| `viper_submit_task_result` | Submit the result against the type's schema — stored, never applied |
| `viper_fail_task` / `viper_release_task` | Give the task back, with or without a failure code |
| `viper_task_queue` | Count of available tasks, for cheap polling |

None of them writes to the base: `submit` creates an `agent_task_result` that a person accepts or
rejects. Mode A (§5) is enough to run this mode — no human-only guard is crossed.

### 3.9 Conversational reads (shipped)

What an assistant (ChatGPT, claude.ai) reads to answer a person. Code:
`backend/app/api/mcp_conversational.py`. Each tool reuses the service **and** the REST output model
of the page that shows the same thing, so the JSON equals the endpoint's answer (the tests compare
them). No SQL in the handlers, no generic query tool, nothing writes.

| Tool | Capability | Source (service → REST output model) |
|---|---|---|
| `viper_search` | `records.read` | `search.search` → `routes/search.search_out` (`SearchOut`) |
| `viper_get_dashboard` | `dashboard.read` | `routes/home.home_dashboard` (`HomeOut`) |
| `viper_get_prospection_metrics` | `dashboard.read` | `prospection.query.base_overview` + `count_segments` (`OverviewOut`, `CountersOut`); `added_within_days` → `count_added_since` |
| `viper_list_missions` | `missions.read` | `missions.list_cards` (`MissionListOut`); filters `status`, `type` |
| `viper_get_mission` | `missions.read` | `missions.detail` → `routes/missions.detail_out` (`MissionDetailOut`) |
| `viper_list_pending_reviews` | `reviews.read` | `missions.pending_proposals` (`ProposalOut`) + `agent_review.get_review` digest; mission cards with `results_pending > 0` |
| `viper_get_contact_overview` | `contact.read` | `routes/contact.dashboard_out` (`ContactDashboardOut`) + `contact_scheduling.overview` (`SchedulingOut`); optional `week` |
| `viper_get_prospect_messages` | `contact.read` | `routes/contact_messages.messages_out` (`MessagesOut`) |

- **« Nouveaux prospects sur N jours ».** `viper_get_prospection_metrics` with `added_within_days`
  (1–366) answers `added: {days, since, total, counts}`: every segment's size among people whose
  `created_at` is within the window (`prospection.query.count_added_since`, same predicates as the
  counters). `segment` adds that segment's count (`segment`, and `added.segment_count`).
- **Pending reviews.** `total` = tool-mode proposals + the submitted results of mission runs. A
  proposal row is the `/api/missions/proposals` row plus the review card's `digest`; missions are
  their ordinary cards. Accepting or rejecting stays in the UI.
- **Capabilities.** Each tool declares one; `app.api.mcp.require(record, capability)` is called
  before the handler and refuses with `capability_denied` when the agent's effective capabilities
  (§4.7) lack it — e.g. a worker token has no `dashboard.read`.
- **Annotations.** Every tool here carries `annotations: {readOnlyHint: true, destructiveHint:
  false, openWorldHint: false}` (advisory for the host; authorization stays server-side).
- **Refusals.** A bad argument (`segment`, `week`, a one-letter `query`, a malformed UUID) or an
  unknown id comes back as `isError: true` with the domain code (`invalid`/`format`, `not_found`),
  and is kept in « Historique des appels » like any call.

### 3.10 Mission actions (shipped)

What an assistant does with a mission for the person it acts for. Code:
`backend/app/api/mcp_missions.py`. An assistant manages **missions**, never raw tasks: there is no
`create_task` tool; VIPER derives each run's tasks (`missions.run_mission`). Every tool parses its
arguments with the REST input model (`routes/missions.MissionIn`, then `mission_input`) and calls
the service the page calls, so the validation is the page's; mutating tools answer the
`MissionDetailOut` of `viper_get_mission`. Reading a mission stays `viper_list_missions` /
`viper_get_mission` (§3.9).

| Tool | Service | Capability | Annotations |
|---|---|---|---|
| `viper_mission_options` | `missions.options`, `agents`, `target_options` (with `target_kind`, `target_search`) | `missions.read` | read-only |
| `viper_create_mission` | `missions.create` (`run_now` → `run_mission`) | `missions.write`, plus `missions.run` when `run_now` | write, not destructive |
| `viper_update_mission` | `missions.update` | `missions.write` | write, not destructive |
| `viper_run_mission` | `missions.run_mission` | `missions.run` | write, not destructive |
| `viper_set_mission_status` | `missions.set_status` | `paused` / `active`: `missions.pause`; `cancelled`: `missions.cancel` | `destructiveHint: true` |
| `viper_delete_mission` | `missions.delete` | `missions.cancel` | `destructiveHint: true` |

- **Input.** `viper_create_mission`'s `inputSchema` is `MissionIn`'s JSON Schema with its `$ref`s
  inlined (name, type, prompt, targets, agent, recurrence, start/end, expected result and limit,
  geography, period, exclusions, `run_now`). `viper_update_mission` takes `mission_id` and only the
  fields that change: they are laid over the mission's current rule (targets included) and the
  whole is validated by `MissionIn` and `missions.update`; a field sent replaces its value,
  `targets` the whole list. `run_now` is refused there (use `viper_run_mission`).
- **Edits and runs.** An edit applies to the next runs; a run keeps the rule it started under
  (`mission_runs.config`, `missions.md` §4), so a task already made is claimed with its old consigne.
  A done or cancelled mission is neither edited nor resumed (`conflict`).
- **Statuses.** An assistant sets `paused`, `active` (resume) or `cancelled`; `done` is reached by
  the rule itself and is refused (`format`). A paused mission is not launched (`conflict`).
- **Capabilities.** A tool names the capabilities its arguments need (`MissionTool.required`); the
  endpoint calls `require` for each before the handler, so a refused call touches nothing. A
  `member` (decision 3) creates, modifies, launches, pauses and resumes; cancelling and deleting
  need `missions.cancel`, which only a `manager` and above lend. A worker has no `missions.*`
  capability: every mission action is `capability_denied`.
- **Annotations.** `viper_set_mission_status` is one tool for pause, resume and cancel, so it is
  declared `destructiveHint: true` as a whole (a host may ask to confirm a pause too); the
  server-side guard still distinguishes them.
- **Audit.** The actor is the agent bound by `/mcp` with its delegated person as `on_behalf_of`
  (§4.7): `mission.created`, `mission.updated`, `mission.status_changed`, `mission.deleted`,
  `agent_task.created` read « Agent · ChatGPT · pour Marie »; the mission's `created_by_*` is the
  agent.
### 3.11 Contact drafts (shipped, HANDOFF §9 phase 2)

An assistant writes the mail of one step of a prospect's sequence; **the result is always a draft**
a person reviews, validates and schedules in VIPER. Code: `backend/app/api/mcp_contact.py`.

| Tool | Capability | Service (same as the editor) → REST output model | Annotations |
|---|---|---|---|
| `viper_generate_contact_draft` | `contact.draft` | `contact_mail_generation.prepare` → the route's generator (`routes/contact_messages.mail_generator_for`) → `generation.draft` → `contact_messages.save_generated` (`GenerationResultOut`) | `readOnlyHint: false`, `destructiveHint: false`, `idempotentHint: false`, `openWorldHint: true` (calls the configured OpenAI model) |
| `viper_update_contact_draft` | `contact.draft` | `contact_messages.save_message` (`MessageResultOut`) | same, `openWorldHint: false` |

- **Arguments.** `prospect_id`, `step` (`contact`, `r1`…), `expected_revision` (omitted only to
  create the step's message). Generate: `instruction`, `replace`. Update: `subject`, `body_text`,
  `from_email`, `to`, `cc`, `bcc` (omitted fields keep their value). The other arguments are parsed
  by the REST body models (`GenerateIn`, `MessageContentIn`, `extra="forbid"`): a `status`,
  `scheduled_at`, `validated_revision` or `sent_at` is refused (`invalid`, with its `field`).
- **Actor.** The agent stays the actor (`ActorType.AGENT`), with the request's
  `AuditContext(source=agent, on_behalf_of=<delegated person>)` (§4.7): the history reads « Agent ·
  ChatGPT · pour Lucie », never a manual edit. The services take `allow_agent=True`
  (`contact_messages.require_author`); without it they stay human-only (the REST routes).
- **Draft only.** `contact_messages.require_agent_draft`: an agent creates a step's message or changes
  a `draft`; a `validated` or `scheduled` message (it carries a person's validation, which an edit
  would drop) or a `cancelled` one answers 409 `agent_draft_only` (with `status`), a `sent` one
  `message_sent_immutable`; generation refuses `scheduled` / `cancelled` first with its own codes
  (`invalid_transition`, `message_cancelled`). Nothing is changed by a refusal, and every refusal of
  generation comes **before** the AI call. Validation, scheduling, unscheduling, cancelling,
  reopening, deleting, sending and the Infomaniak remote draft are not exposed.
- **Revision.** The editor's rules apply unchanged: a stale `expected_revision` answers
  `revision_conflict`, a missing one on an existing message `message_exists`, a text without
  `replace: true` `replace_confirmation_required`; a closed sequence, S0, `do_not_contact`, a rank
  beyond « max relances » keep their codes.
- **Workers.** `contact.draft` is in the `interactive` defaults only; `worker` and `scheduled`
  tokens are refused with `capability_denied`.
- **AI failures.** `ai_not_configured`, `ai_timeout`, `ai_rate_limited`, … come back as the refusal
  `code` and VIPER's own `message`; nothing is written. The provider's text and its error type
  (`upstream_code`) are never returned; the `ai_upstream_error` message does name the provider's
  HTTP status (« The AI service failed (HTTP 500) »).
- **Transaction.** Unlike the REST route (which commits before the AI call), the call runs inside the
  MCP request's transaction and its savepoint, so the agent's token row (`last_used_at`) stays locked
  for the AI call's duration: a parallel call of the same agent waits.
- **Refusals.** A `ContactMessageError` or `MailGenerationError` keeps its stable `code` (and the
  message refusal's details) in the MCP refusal; it is kept in « Historique des appels ».

### 3.12 Mission card (MCP Apps UI, shipped)

An optional HTML card ChatGPT renders next to `viper_create_mission`'s result. Code:
`backend/app/api/mcp_ui.py` (catalogue, metadata) and
`backend/app/api/mcp_ui_templates/mission_card.html` (the card). Keys follow the **MCP Apps** extension (protocol `2026-01-26`) that the OpenAI Apps SDK
documents as the standard, plus the `openai/*` aliases it still reads (checked 2026-11-03 on
`developers.openai.com/plugins/build/chatgpt-ui` and `/apps-sdk/reference`).

- **Resources.** `initialize` announces `resources` (`listChanged: false`, `subscribe: false`).
  `resources/list` lists one template, `ui://viper/mission-card-v1.html`, `mimeType`
  `text/html;profile=mcp-app` (formerly `text/html+skybridge`); `resources/read` returns its HTML.
  An unknown URI is JSON-RPC error `-32002`. `resources/templates/list` is empty. Any valid token
  may read a template (it holds no data); the bearer check still applies. The version is in the URI
  because hosts cache templates by URI: a changed card gets a new one.
- **Resource `_meta`.** `ui.prefersBorder: true`, `ui.csp` with empty `connectDomains` and
  `resourceDomains` (the card loads nothing and calls VIPER only through the host),
  `openai/widgetPrefersBorder`, `openai/widgetDescription`. No `ui.domain`: it depends on the
  public origin and is only required for a published ChatGPT app.
- **Tool `_meta`.** `viper_create_mission` carries `ui.resourceUri` and its alias
  `openai/outputTemplate`, `openai/widgetAccessible: true` and the `openai/toolInvocation/*`
  status strings. Every result of `viper_create_mission`, refusals included, carries
  `_meta.ui.resourceUri` and `openai/outputTemplate` too, so a refused creation still renders the
  card with the server's error. The tools the card calls (`viper_mission_options`,
  `viper_update_mission`, `viper_run_mission`) carry `openai/widgetAccessible: true` (ChatGPT's
  older bridge); `ui.visibility` is left to its default (`model` and `app`). The schemas and
  annotations do not change: a client that ignores `_meta` sees the same tools.
- **The card.** French, self-contained (inline CSS and JS, no dependency). It reads the tool's
  arguments and result from `window.openai` (`toolInput`, `toolOutput`, `theme`, `widgetState`,
  event `openai:set_globals`) or, without it, from the MCP Apps `postMessage` bridge
  (`ui/initialize`, `ui/notifications/tool-input`, `tool-result`, `host-context-changed`,
  `size-changed`). It shows the interpretation (type, zone, période, résultat, maximum, récurrence,
  agent, cibles) and:
  - **result is a mission** → « Lancer maintenant » (`viper_run_mission`, active mission only) and
    « Modifier les paramètres » → « Enregistrer » (`viper_update_mission` with only the changed
    fields) / « Annuler » (or Escape);
  - **result is a refusal** (or a call answered nothing after 60 s) → the form, prefilled from
    the arguments, with « Créer » and « Créer et lancer » (`viper_create_mission`, `run_now`); the
    card changes only the fields it shows and passes every other argument (targets, exclusions,
    dates) through untouched.
  A refusal is shown as returned (`message`, plus the field and `code`), the field marked
  `aria-invalid`. A call shows its label and a live counter, disables the buttons, and gives up
  after 45 s with a message that the request may still have succeeded (a late mission is still
  shown). The created or modified mission is kept in `widgetState` so the card survives a reload.
- **Authorization.** None in the card. Every action is a `tools/call` back through the host to
  `/mcp`, which runs the same `require` as when the model calls the tool: an agent without
  `missions.run` gets `capability_denied` for « Créer et lancer », shown as returned.
- **Creation is additive.** With the template on `viper_create_mission`, the mission exists when the
  card first appears (HANDOFF §14: no redundant confirmation); « Créer » / « Créer et lancer »
  serve when that creation was refused. A pre-creation preview would need a read-only render tool;
  not built (open question, §6).

### 3.8 Deliberately not exposed

| Capability | Endpoints | Why |
|---|---|---|
| Authentication | `POST /auth/login`, `/logout`, `GET /session` | MCP has its own bearer credential; a tool that logs in is a credential-leak vector |
| Integrations and secrets | `GET/PUT /settings/integrations`, `POST /settings/toolbox/*`, `/integrations/*/check`, diagnostics | The OpenAI key and the Infomaniak token live here; "never returned to the browser" must also mean "never returned to a model" |
| Destructive | `POST /database/reset-prospecting`, `DELETE /prospects/{id}`, `/companies/{id}`, `/notes/{id}` | Irreversible; a human does it in the UI |
| Staged table writes | `POST /explorer/tables/{t}/changes`, `GET …/delete-check` | Bypasses every domain rule (contactability, sequences, audit semantics) |
| Bulk mail and message transitions | `POST /contact/schedule-cohorts`, `POST …/{step}/release`, `cancel`, `delete`, `reopen`, `remote-draft` | Outbound mail and irreversible message transitions; the human keeps them |
| Import / export | `POST /imports/preview`, `/commit`, `GET /exports/workbook`, `GET /explorer/tables/{t}/export` | Binary payloads plus a human review grid; the ADR-0012 review is stateless and would be lost |
| Settings and taxonomies writes | `POST/PATCH/DELETE /settings/*` | Changes the vocabulary the rest of the base is read with; human-only today |
| Calendly sync | `POST /agenda/sync` | Background job trigger, no value through a tool call |

Optional phase 3, only if the curated tools prove insufficient: **`viper_run_sql`** over
`POST /explorer/sql`. It is genuinely read-only (guaranteed by the PostgreSQL role, ADR-0011), which
makes it safe on paper — but it returns arbitrary rows, is unbounded in shape, and duplicates the
curated tools. Recommended only with a row cap, a statement timeout, and an explicit
`read_only: true` argument echoed in the result.

## 4. Transport, identity and audit

### 4.1 Mount point

MCP Streamable HTTP is `POST` + SSE on a single path. Mounting it under `api_router` would hit
`require_session` and the CSRF check (any unsafe method) and fail. It must be a **separate ASGI app
mounted outside `/api`** (e.g. `/mcp`), with its own authentication dependency and its own
`audit.bind`. The stateless exchange already implemented in
`app/services/toolbox/mcp_client.py` is the mirror image of what the server side must accept:
`initialize` → `notifications/initialized` → `tools/list` / `tools/call`, `protocolVersion`
`2025-06-18`.

### 4.2 Credential

Not the browser cookie. A dedicated table (`mcp_tokens`: label, SHA-256 of the token, owner
`users.id`, scopes `read`/`write`, expiry, last used) and a `Authorization: Bearer` header, hashed
at rest like `user_sessions` already does. One token per assistant. Revocation is a row update —
the UI's "Connexions" page is the natural place to list and revoke them, next to the Toolbox.

### 4.3 Actor and audit

Two modes, and the choice is a product decision, not an implementation detail:

**Mode A — the agent is an agent.** Every tool call builds
`ActorContext(type=AGENT, id=<token id>, display=<token label>)`. Reads, prospect/company edits,
notes, contactability and appointments work. Contact states, message drafts and cohorts are
refused by the existing guards, and the tool returns a clean `not_allowed_for_agent` error
explaining that a person must do it in VIPER. Pros: no rule is bent, `D7` ("a contact state is
chosen by a person, never by an agent") stays literally true, audit is unambiguous. Cons: the most
useful write is missing.

**Mode B — the agent acts on behalf of the signed-in person.** The token is bound to a `users` row;
the server builds `ActorContext(type=HUMAN, id=user.id, display=…)` and
`AuditContext(source=AGENT, on_behalf_of=<owner>)`, which is exactly what `on_behalf_of` was
designed for. Every human-only service accepts the call. Pros: the whole catalogue works. Cons: "a
person validated this mail" now means "an assistant acting for a person", and the UI badge must
say so; without an explicit confirmation step (MCP elicitation, or a "to validate" queue in the
UI), `D7` becomes a convention instead of an invariant.

**Recommended split:** Mode A by default, plus **one narrow door**: draft writing only, where the
result is an unreviewed `draft` the person must still validate in VIPER. *Shipped (§3.11) without
Mode B:* the agent stays the actor and the services open only the draft writes to it
(`allow_agent`). Validation, scheduling and sending stay human, in the UI — they are the three
calls that make `D7` real. This keeps the code's line intact while making the useful use case work.

Whatever the mode, every write must record `source=agent` and `request_id`, so the history can
distinguish "Lucie did it" from "Lucie's assistant did it".

### 4.4 Contract details worth fixing now

- **Concurrency**: every write takes `expected_version` (prospect) or `expected_revision`
  (message). On mismatch, return a `conflict` error **carrying the fresh object**, so the assistant
  can reconcile instead of re-reading blindly.
- **Idempotency**: `viper_create_prospect` and `viper_save_appointment` accept an
  `idempotency_key`; a retried call returns the first result. MCP clients do retry.
- **Errors**: reuse the existing `{"detail": {"code", "message", …}}` shape, mapped to
  `isError: true` with the stable `code` in the text (the Toolbox client already classifies that
  way). French message, English code.
- **Limits**: `limit` ≤ 200 (domain max), `offset` allowed, no unbounded list. One page = one tool
  call; the agent loops.
- **Language**: English tool names and descriptions (code convention, token-efficient), French
  values and error messages (product convention). To be confirmed — it is the one place where the
  two conventions meet.

### 4.5 OAuth for connectors (ChatGPT, claude.ai)

> **Status: implemented** (migration `0022`). Hosted connectors cannot be given a fixed bearer
> token: ChatGPT (developer mode) and claude.ai (custom connector) only offer OAuth or no
> authentication. VIPER is therefore its own OAuth 2.1 authorization server for `/mcp`.

- **Discovery.** `/mcp` answers 401 with `WWW-Authenticate: Bearer resource_metadata="…"` pointing
  to `/.well-known/oauth-protected-resource` (RFC 9728; also under `/mcp`), which names VIPER as
  the authorization server; `/.well-known/oauth-authorization-server` (RFC 8414, aliased as
  `openid-configuration`) lists the endpoints. URLs follow the request's scheme and host (uvicorn
  trusts Caddy's forwarded headers).
- **Registration.** `POST /oauth/register` (RFC 7591), open: HTTPS redirect URIs (HTTP only to
  localhost), at most 10, no fragment; public clients (`none`, PKCE only) or confidential ones
  (`client_secret_post` / `client_secret_basic`, the secret answered once, stored hashed);
  1 000 clients at most.
- **Authorization.** `GET /oauth/authorize` checks the client and its exact redirect URI (an
  unknown one is never followed: the person lands on `/autoriser?erreur=…`), `response_type=code`
  and PKCE `S256` (other faults go back to the redirect with `error` and `state`), stores the
  request (10 min) and sends the browser to the SPA page `/autoriser?demande=<id>`. That page is
  behind the sign-in like every page; « Autoriser » / « Refuser » are
  `POST /api/oauth/requests/{id}/approve|deny` (session + CSRF). An approval mints an ordinary
  `mcp_tokens` row labelled « <client> (OAuth) » with every scope, `mode=interactive`, every
  capability and a `provider` read from the client's name (§4.7) — the connector is one more agent,
  with the same claims, attribution and audit — and a one-time code (5 min).
- **Tokens.** `POST /oauth/token`: `authorization_code` (client, code, redirect URI and PKCE
  verifier checked) answers an access token (`viper_at_…`, 1 h) and a refresh token
  (`viper_rt_…`, 60 days); `refresh_token` rotates the pair. A code or a refresh token used twice
  revokes every token of the grant (the revocation is committed although the request fails).
  `/mcp` accepts both kinds of credential: a CLI token or a live OAuth access token whose agent is
  not revoked. Only SHA-256 hashes are stored (`oauth_clients`, `oauth_authorizations`,
  `oauth_tokens`; hidden from the explorer, not audited — they are secrets).
- **Revocation.** Paramètres › MCP › « Accès autorisés » lists the agent credentials the signed-in
  person manages (OAuth or CLI, never a token; §4.8) with « Révoquer »
  (`POST /api/settings/mcp/agents/{id}/revoke`): the agent and every OAuth token derived from it
  stop at once.
- **Deployment.** Caddy proxies `/.well-known/*` and `/oauth/*` to the API next to `/api/*` and
  `/mcp*`. The Vite dev server proxies `/api` only: test the connector flow against the deployed
  stack (or `deploy/docker-compose.prod.yml` locally).

### 4.6 Call history (« Historique des appels »)

- **Owner of each token.** Every agent token names the person it acts for, in `mcp_tokens.owner_email`.
  - For an OAuth connector, this is the account that approved it.
  - For a command-line token, it is `--owner-email`.
- **One row per call.** Each `tools/call` writes a row in `mcp_calls`, with:
  - the moment of the call;
  - `user_email` and the token's label, both copied from the token so they survive a revocation;
  - the tool and its arguments (texts cut at 300 characters, lists at 50 items, nesting at 4 levels);
  - `outcome`: `ok`, or `refused` with the tool's error code and message;
  - the duration.
- **Refused calls are kept.** The row is written outside the tool's savepoint, so a refused call stays in the history.
- **Not logged:** `initialize`, `ping` and `tools/list`.
- **Where to read it.** Paramètres › MCP › « Historique des appels » shows the history, filterable by person and by
  tool, through `GET /api/settings/mcp/calls`.
  - Parameters: `email`, `tool`, `agent_id`, `before`, `limit` (at most 200).
  - Results are newest first. To get the next page, pass the `created_at` of the last row as `before`.
  - Only the calls of the agents the signed-in person manages (§4.8), the `emails` and `tools`
    filter lists included.
- **Write-once.** The table is not audited and is not shown in the explorer.

### 4.7 Agent identity and capabilities (`viper_whoami`)

Decisions 2 and 3 of the ChatGPT handoff (`tasks/viper_chatgpt_conversational/READINESS.md`). There
is no separate agent table: an `mcp_tokens` row **is** the agent. Code:
`backend/app/services/agent_capabilities.py` (vocabulary, defaults, intersection),
`backend/app/api/mcp.py` (`require`, `viper_whoami`), migration `0025`.

- **Columns.** `provider` (`chatgpt`, `claude`, `chatx`, `other`), `mode` (`interactive`, `worker`,
  `scheduled`) and `capabilities` (JSONB list). `scopes` stays a filter on task types, distinct from
  the capabilities.
- **Vocabulary.** `tasks.work` (claim, heartbeat, submit, fail, release, queue), `records.read`,
  `records.propose`, `dashboard.read`, `missions.read`, `missions.write` (create, modify),
  `missions.run`, `missions.pause` (pause, resume), `missions.cancel` (cancel, delete),
  `reviews.read`, `contact.read`, `contact.draft`. An unknown name is refused at mint time and is a
  programming error in `require`.
- **Defaults by mode.** `worker`: `tasks.work`, `records.read`, `records.propose` (exactly what a
  worker could do before). `interactive`: every capability — `tasks.work` included, so a connector
  already used as a worker keeps claiming. `scheduled`: `tasks.work`, `records.read`,
  `records.propose`, `dashboard.read`, `missions.read`, `reviews.read`, `contact.read`.
- **Migration 0025.** Existing tokens become `worker` with the worker defaults; tokens minted by an
  OAuth approval become `interactive` with every capability, and their `provider` is read from
  `oauth_clients.client_name` (`chatgpt`/`openai` → `chatgpt`, `chatx`, `claude`/`anthropic` →
  `claude`, else `other`). Reversible.
- **Effective capabilities** = the agent's own ∩ the role of its **delegated person**, computed
  once per request (`agent_capabilities.grant_for`), so a role change applies at the next call.
  - Delegated person: for an OAuth connector, the account that approved it
    (`oauth_authorizations.user_id`); for any other token with an `owner_email` — every mode,
    workers included — the account of that address; nobody for a token without `owner_email` (a
    command-line worker: its own capabilities only).
  - Roles: `admin` and `manager` lend every capability; `member` everything but `missions.cancel`;
    the platform admin everything.
  - Fails closed: a deactivated delegated account lends nothing (`restriction:
    delegated_user_inactive`); a token whose delegated account does not exist (OAuth approver
    deleted, `owner_email` of no account) may do nothing (`delegated_user_missing`).
- **Guard.** `require(record, capability)` is the single check; every tool but `viper_whoami`
  starts with it. A refusal is `isError: true` with
  `{"code": "capability_denied", "capability": …, "message": …}` and is kept in `mcp_calls` with
  `outcome = refused`, `error_code = capability_denied`. The grant lives in a context variable set by
  `handle_mcp` for the request; outside a request, or for another token, `require` refuses.
- **Existing tools.** The six task tools need `tasks.work`; `viper_list_companies`,
  `viper_get_company`, `viper_list_prospects`, `viper_get_prospect` need `records.read` (and carry
  read-only annotations); `viper_update_company` / `viper_update_prospect` need `records.propose`
  (the task-type scope still applies after it). The mission actions (§3.10) may need more than one
  capability for one call (`viper_create_mission` with `run_now`) or one that depends on an
  argument (`viper_set_mission_status`): `require` is called for each. The contact draft tools
  (§3.11) need `contact.draft`.
- **Annotations.** Every tool but eight carries `annotations`: the reads are read-only, the
  mission writes and the draft tools are not destructive, `viper_set_mission_status` and
  `viper_delete_mission` are the only ones with `destructiveHint: true`. The six task tools and
  `viper_update_company` / `viper_update_prospect` carry none, so the MCP defaults apply to them
  (`destructiveHint: true`, `openWorldHint: true`): a host may ask to confirm a claim or a submit.
  Follow-up: `tasks/viper_chatgpt_conversational/Issues/s08-integration-followups.md`.
- **`viper_whoami`** (no capability needed) answers, as VIPER sees it — never what the model
  claims: `agent_id`, `label`, `provider`, `mode`, `delegated_user` (`email`, `display_name`,
  `role`, `platform_admin`, `active`, or `null`), `organization` (`id`, `name`), `capabilities`
  (effective, in vocabulary order), `restriction` (`delegated_user_missing`,
  `delegated_user_inactive` or `null`), `task_types` and `version`.
- **Audit.** Every `/mcp` request binds the agent as the actor (`ActorType.AGENT`, the token's id
  and label) with `AuditContext(source=agent, on_behalf_of=<the delegated person>)`. The history
  shows it as « Agent · ChatGPT (OAuth) · pour Lucie » (`frontend/src/history/format.ts`), never as
  a manual action of that person.
- **Paramètres › MCP.** « Accès autorisés » shows each agent's platform, mode and own capabilities.
  « Créer un jeton » (`POST /api/settings/mcp/agents`: `label`, `provider`, `mode`, `capabilities`
  — omitted: the mode's defaults) mints a bearer token acting for the signed-in person, every task
  type, shown once. Nobody grants more than their own role allows (403 `forbidden`), since a
  worker's capabilities are not intersected later. `GET /api/settings/mcp` serves the vocabulary
  (`capabilities`, with French labels), `mode_defaults` and `grantable` (what the signed-in
  person's role allows): the dialog offers only those, unchecks the rest of a mode's defaults and
  shows them disabled, so a `member` creating an assistant is not refused for `missions.cancel`
  (the 403 stays the guard). The command line takes `--mode`,
  `--provider` and `--capabilities` (`create-agent-token`).
- **Limit.** Regenerating a bearer token creates a new identity
  (`tasks/viper_chatgpt_conversational/Issues/bearer-token-rotation.md`).

### 4.8 Who may see and revoke an agent

Code: `backend/app/services/mcp_access.py`, used by the three routes of « Accès autorisés » and
« Historique des appels ». A person **manages** an agent token when:

- it acts for them: its delegated person (§4.7, `agent_capabilities.delegate_of` — the OAuth
  approver, else the account of `owner_email`) is the signed-in account;
- they are an active `admin` of the agent's organisation — the delegated person's organisation, or
  the token's own `organization_id` for a token acting for nobody;
- they are the platform admin (`is_superadmin`).

A token acting for nobody (no `owner_email`, or one naming no account) is therefore managed by the
admins and the platform admin only. A `manager` is treated like a `member` here.

- `GET /api/settings/mcp/agents` lists the managed agents only: a member sees their own, an admin
  every agent of their organisation, the platform admin all of them. Every listed agent can be
  revoked by the viewer, so the page shows « Révoquer » on each live row without a client-side rule.
- `GET /api/settings/mcp/calls` keeps the calls of the managed agents only (a call whose token row
  is gone is then visible to the platform admin alone).
- `POST /api/settings/mcp/agents/{id}/revoke` on an agent the person does not manage answers
  **404 `not_found`**, exactly like an unknown id — not 403: the list already hides these agents,
  so for that person they do not exist, and a member cannot probe which agent ids are live.
- Creating a token (`POST /api/settings/mcp/agents`) is unchanged: it is bounded by the creator's
  role (§4.7).

## 5. Rollout

**M1 — read-only (no product decision needed).** *Partially shipped:* the basic company/person
lookups (`viper_list_companies`, `viper_get_company`, `viper_list_prospects`, `viper_get_prospect`)
and the conversational reads of §3.9 (which cover `viper_overview`, `viper_search`,
`viper_get_contact_plan` and the message half of `viper_get_outreach`). Still to do:
`viper_get_reference_data`, `viper_find_prospects`. All are read, mapped to
existing services, and safe behind a read-only token.

**M2 — curated writes.** *Partially shipped as proposals:* `viper_update_company` and
`viper_update_prospect` store a reviewable result instead of writing (the mission pipeline, without
the claim). Still to do: `viper_create_prospect`, `viper_create_company`, `viper_add_note`,
`viper_set_contactability`, `viper_save_appointment`. The draft door shipped as the contact draft
tools (§3.11).

**M3 — missions.** *Shipped:* the six task tools of §3.7, with the orchestration model of
[`agent-missions.md`](agent-missions.md), then the conversational mission actions of §3.10 and
their card (§3.12): an assistant manages missions, VIPER derives the tasks, a worker claims them,
and every result stays a proposal a person accepts in « Agents ».

**M4 — optional.** `viper_run_sql`, `viper_list_activity`, `viper_get_prospect_history`, import review.

## 6. Open questions

1. ~~**Where does the agent sit?**~~ *Decided:* Mode A + the draft door (§4.3, §3.11). The agent
   stays the actor; validation, scheduling and sending stay human.
2. ~~**Who owns a token?**~~ *Decided (ChatGPT handoff, decisions 2–3):* one agent per token, acting
   for one person (the OAuth approver or `owner_email`), whose role bounds its capabilities
   (§4.7). A command-line worker without `owner_email` acts for nobody.
3. **Should the assistant see personal data at all?** The base is *people* — names, e-mails, phones.
   MCP makes it reachable from another process, possibly a hosted model. Scope `read` tokens to
   segments/fields, or accept the risk for an internal pilot like the OpenAI key decision
   (2026-10-01)?
4. **Do we expose the SQL console?** Curated tools first; the console only if a real need appears.
5. **Naming and description language** (§4.4).
6. **A mission preview before creation?** The card renders after `viper_create_mission` (§3.12),
   so the mission already exists. Showing the interpretation *before* creating it would take a
   read-only render tool (e.g. `viper_prepare_mission`) carrying the template instead; to decide
   once the card has been tried in ChatGPT.

## 7. What this document does not decide

The server framework (`mcp` Python SDK vs. a hand-rolled JSON-RPC layer, as the Toolbox client
already is), the session model, and the UI to manage tokens. Those follow from the answers to §6.
