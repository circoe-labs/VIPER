# VIPER as an MCP server — tool catalogue (proposal)

> **Status: implemented** for §3.7 and §4 (transport, tokens, six mission tools), plus the basic
> tool mode of §3.2 and the two `update` proposals of §3.4: `viper_list_companies`,
> `viper_get_company`, `viper_list_prospects`, `viper_get_prospect`, `viper_update_company` and
> `viper_update_prospect`, and the conversational reads of §3.9 (`viper_search`,
> `viper_get_dashboard`, `viper_get_prospection_metrics`, `viper_list_missions`,
> `viper_get_mission`, `viper_list_pending_reviews`, `viper_get_contact_overview`,
> `viper_get_prospect_messages`). The create/discovery/contact-write tools are still proposals.
> This document lists the MCP tools worth exposing, the ones deliberately left out, and the
> product decisions that must be taken before writing code. It follows the repo rule: product
> names in French, code and technical documentation in English.

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
  | "A Contact message is handled by a person." | `services/contact_messages.py:238` | `save_message`, `save_generated`, `validate`, `schedule`, `mark_sent`, `schedule_cohorts` are human-only |
  | "AI drafting is started by a person." | `services/contact_mail_generation.py:291` | `generate` is human-only |
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
| `viper_save_message_draft` | Write the Contact/R1/R2 draft (subject, body, recipients); editing a validated message sends it back to draft | `PUT /prospects/{id}/messages/{step}` | `_require_human`, `contact_messages.py:238` |
| `viper_validate_message` | Human validation of the current revision | `POST …/validate` | idem — **should probably stay out even in mode B** |
| `viper_schedule_message` | Give a validated message its send moment | `POST …/schedule` | idem |
| `viper_mark_message_sent` | Declare a send that happened outside VIPER | `POST …/mark-sent` | idem |
| `viper_set_tracking_status` | Choose the commercial state (`neutral`, `response_received`, `appointment_obtained`, `ignored`, `disqualified`) | `PATCH /prospects/{id}/tracking` | `prospect_editor.py:782`, `contact_tracking.py:84` |
| `viper_set_cohort` | Put a person in a cohort (restarts the counter, cancels unsent mail) | `PUT /prospects/{id}/cohort` | `contact_sequences.py:391` |
| `viper_raise_alert` / `viper_resolve_alert` | Quality signal on a record | `POST /alerts`, `POST /alerts/{id}/resolve` | `quality_alerts.py:181` |

`viper_save_message_draft` is the single most valuable tool of the whole catalogue — it is what
"drive VIPER from an assistant" means in practice. It is also the one the code refuses to an agent.
That tension is the subject of §5; it must not be resolved by silently passing a human actor.

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
  before the handler. Until the capability model of the ChatGPT handoff (Slice 01) lands it is a
  provisional seam that allows everything.
- **Annotations.** Every tool here carries `annotations: {readOnlyHint: true, destructiveHint:
  false, openWorldHint: false}` (advisory for the host; authorization stays server-side).
- **Refusals.** A bad argument (`segment`, `week`, a one-letter `query`, a malformed UUID) or an
  unknown id comes back as `isError: true` with the domain code (`invalid`/`format`, `not_found`),
  and is kept in « Historique des appels » like any call.

### 3.8 Deliberately not exposed

| Capability | Endpoints | Why |
|---|---|---|
| Authentication | `POST /auth/login`, `/logout`, `GET /session` | MCP has its own bearer credential; a tool that logs in is a credential-leak vector |
| Integrations and secrets | `GET/PUT /settings/integrations`, `POST /settings/toolbox/*`, `/integrations/*/check`, diagnostics | The OpenAI key and the Infomaniak token live here; "never returned to the browser" must also mean "never returned to a model" |
| Destructive | `POST /database/reset-prospecting`, `DELETE /prospects/{id}`, `/companies/{id}`, `/notes/{id}` | Irreversible; a human does it in the UI |
| Staged table writes | `POST /explorer/tables/{t}/changes`, `GET …/delete-check` | Bypasses every domain rule (contactability, sequences, audit semantics) |
| Bulk mail and message transitions | `POST /contact/schedule-cohorts`, `POST …/{step}/release`, `cancel`, `delete`, `reopen`, `remote-draft` | Outbound mail and irreversible message transitions; the human keeps them |
| AI drafting | `POST …/{step}/generate` | Redundant when the caller *is* a model: the assistant writes the text itself and stores it with the draft tool. Keeping both invites paying twice for the same paragraph |
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

**Recommended split:** Mode A by default, plus **one narrow Mode B door**: draft writing only
(`viper_save_message_draft`), where the result is an unreviewed `draft` the person must still
validate in VIPER. Validation, scheduling and sending stay human, in the UI — they are the three
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
  `mcp_tokens` row labelled « <client> (OAuth) » with every scope — the connector is one more
  agent, with the same claims, attribution and audit — and a one-time code (5 min).
- **Tokens.** `POST /oauth/token`: `authorization_code` (client, code, redirect URI and PKCE
  verifier checked) answers an access token (`viper_at_…`, 1 h) and a refresh token
  (`viper_rt_…`, 60 days); `refresh_token` rotates the pair. A code or a refresh token used twice
  revokes every token of the grant (the revocation is committed although the request fails).
  `/mcp` accepts both kinds of credential: a CLI token or a live OAuth access token whose agent is
  not revoked. Only SHA-256 hashes are stored (`oauth_clients`, `oauth_authorizations`,
  `oauth_tokens`; hidden from the explorer, not audited — they are secrets).
- **Revocation.** Paramètres › MCP › « Accès autorisés » lists every agent credential (OAuth or
  CLI, never a token) with « Révoquer » (`POST /api/settings/mcp/agents/{id}/revoke`): the agent
  and every OAuth token derived from it stop at once.
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
- **Write-once.** The table is not audited and is not shown in the explorer.

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
`viper_set_contactability`, `viper_save_appointment`, then the Mode B door for
`viper_save_message_draft`.

**M3 — missions.** The five task tools of §3.7, with the orchestration model of
[`agent-missions.md`](agent-missions.md). Independent of M2: `viper_claim_task` and
`viper_submit_task_result` cross no human-only guard, so they can ship before the Mode B decision is
taken. The only prerequisite is the token and the `/mcp` mount point of §4.

**M4 — optional.** `viper_run_sql`, `viper_list_activity`, `viper_get_prospect_history`, import review.

## 6. Open questions

1. **Where does the agent sit?** Mode A only, Mode A + draft door (recommended), or full Mode B?
   This single answer decides half the catalogue.
2. **Who owns a token?** One token per person (so `on_behalf_of` has a meaning) or one shared
   service token (simpler, but every write is attributed to "the assistant")?
3. **Should the assistant see personal data at all?** The base is *people* — names, e-mails, phones.
   MCP makes it reachable from another process, possibly a hosted model. Scope `read` tokens to
   segments/fields, or accept the risk for an internal pilot like the OpenAI key decision
   (2026-10-01)?
4. **Do we expose the SQL console?** Curated tools first; the console only if a real need appears.
5. **Naming and description language** (§4.4).

## 7. What this document does not decide

The server framework (`mcp` Python SDK vs. a hand-rolled JSON-RPC layer, as the Toolbox client
already is), the session model, and the UI to manage tokens. Those follow from the answers to §6.
