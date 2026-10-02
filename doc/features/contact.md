# Contact — dashboard, mail sequence and the Contact page

Contact port, Slice S3 (handoff Tasks 09, 11, 12; decisions H-14 … H-29 of
`tasks/viper_contact_pipeline_handoff/docs/01-decision-log.md`) for the API, Slice S4 (Tasks 08, 10, 13) for the page
([§ Contact page](#contact-page-ui-slice-s4)), Slice S5 (Task 14) for the AI drafting
([§ AI drafting](#ai-drafting-s5--post-apiprospectsprospect_idmessagesstepgenerate)), Slice S6 (Task 15) for the
Infomaniak drafts ([§ CIRCOE Toolbox](#circoe-toolbox-s6--infomaniak-drafts-of-validated-messages)) and Slice S7
(Tasks 16-17) for the scheduled sending ([§ Scheduled sending](#scheduled-sending-s7)). States of a prospect and the next-action week are described in
[`prospect-editor.md`](prospect-editor.md) (`PATCH /api/prospects/{id}/tracking`) and
[`prospection-kpis.md`](prospection-kpis.md); the table is in
[`../architecture/data-model.md`](../architecture/data-model.md#contact_messages).

Every endpoint below requires a session; `PUT`/`POST` also the CSRF header (`X-CSRF-Token`). Refusals use the
shared shape `{"detail": {"code": "...", "message": "...", ...}}`; a malformed request (unknown field, wrong type,
missing `expected_revision`, naive `scheduled_at`, unknown step/counter) is FastAPI's 422 `{"detail": [...]}`.

## Dashboard — `GET /api/contact/dashboard`

Query: `q` (optional, ≤ 200 chars — the Prospection search: every word in names/company or an e-mail, or a phone
number).

```json
{
  "today": "2026-12-31",
  "current_week": "2026-W53",
  "counts": {"to_handle": 6, "first_contact": 3, "follow_up": 2, "review": 1, "appointments": 2},
  "weeks": [{"week": "2026-W52", "year": 2026, "number": 52, "count": 3}],
  "dispatch": {"active": false, "reason": "disabled", "scheduled_count": 2, "overdue_count": 1}
}
```

**`dispatch`** (S9, Human report of 2026-10-02: « J’ai programmé un mail de contact hier et il ne s’est jamais
envoyé ») — will a scheduled message really leave? `app/services/contact_dispatch_state.py`, the one answer read by
this banner, the editor (`defaults.dispatch_reason`) and Paramètres › Connexions: `active` = the dispatcher runs and
the Toolbox is connected; `reason` when not, the person's choice first — `disabled` (switch *Envoi automatique des
mails programmés* off, or an interval of 0), then `toolbox_disabled`, `toolbox_not_configured`,
`toolbox_disconnected`, `toolbox_expired`, and `not_running` (switched on and connected but no worker: should not
happen, see the server log); `scheduled_count` = messages in « Programmé » (all of them, not narrowed by `q`);
`overdue_count` = of those, not claimed and whose `scheduled_at` has passed.

**Scope** of Contact: prospects with a contact tracking whose state is not `ignored` (terminal, outside Contact) and
who are not `do_not_contact` — except `appointment_obtained`, kept whatever the opposition (« RDV pris » is a
cumulative fact). `failure`, `response_received`, `appointment_obtained` stay in scope (filterable).

**Counters** (read-only; each equals the `total` of `GET /api/contact/prospects?counter=<key>` under the same `q`):

| Key | Card | Definition |
|---|---|---|
| `to_handle` | À traiter cette semaine | union of the three below (disjoint by state) |
| `first_contact` | Premier contact | `neutral`, next action reached or overdue |
| `follow_up` | Relances | `contacted` (R1 to prepare) or `r1` (R2 to prepare), reached or overdue |
| `review` | Revues R2 | `r2`, reached or overdue — a human review/closing, not another mail (H-13) |
| `appointments` | RDV pris | current state `appointment_obtained`, cumulative, no time window (H-18), opposed or not (only `ignored` is excluded) |

« Reached or overdue » = `planned_contact_at` before next week's Monday (business time, Europe/Paris), i.e. the
next-action ISO week ≤ the current ISO week. The four due counters exclude `do_not_contact` and `inactive`
prospects (Prospection's `actionable()`). An overdue week never changes a state (H-10): it stays « à traiter » until a
person acts. `weeks` = the ISO weeks present in the planning (scope, under `q`), oldest first — the week selector's
options; `current_week` is the server's « cette semaine ».

## List — `GET /api/contact/prospects`

Query (combined with AND): `counter` (a key above), `week` (`YYYY-Www`, exact ISO week of the next action),
`state` (any Contact state but `ignored`), `q`, `limit` (1-200, default 50), `offset` (≥ 0). Without `counter`,
`week` and `state` the list is **the planning**: only prospects with a next-action week (a prospect without one
appears only under an explicit `state`). The server does not default `week` to the current week: the page sends
`current_week` from the dashboard when its selector is on « cette semaine » (so the « à traiter » cards keep the
overdue weeks). Order: next action (soonest first, none last), last name, first name, id.

```json
{
  "items": [{
    "id": "…", "civility": "ms", "first_name": "…", "last_name": "…", "exact_job_title": "…",
    "role_label": "…", "company_id": "…", "company_name": "…", "primary_email": "…",
    "activity_status": "active", "tracking_status": "contacted",
    "planned_contact_at": "2026-12-27T23:00:00Z", "next_action_week": "2026-W53",
    "due": true, "next_step": "r1",
    "messages": {"contact": "sent", "r1": "draft", "r2": null}
  }],
  "total": 1, "limit": 50, "offset": 0
}
```

`due` = in `to_handle`. `next_step` = what the next action prepares: `contact` (neutral), `r1` (contacted), `r2`
(r1), `review` (r2), `null` otherwise. `messages` = status of each step's message, `null` = never created.

Refusals: 422 `invalid` with `field: "week"`, `reason: "iso_week"` (malformed or non-existent week, e.g. `2025-W53`,
or a year outside 2000-2100);
422 `invalid` with `field: "state"`, `reason: "not_filterable"` (`ignored`).

The left panel uses `GET /api/prospects/{id}` (editor view, with tracking and cadence suggestion) and changes the
state/week with `PATCH /api/prospects/{id}/tracking`.

**Effect on the messages** (additive fields, S3): `PATCH /api/prospects/{id}/tracking`, the editor save
`PUT /api/prospects/{id}` and the opposition `PUT /api/prospects/{id}/contactability` answer the editor view plus
`cancelled_messages` (unsent messages cancelled by this save) and `in_flight_messages` (messages claimed by the
dispatcher, left to it — they may still leave). Both are 0 when nothing closed the sequence; `POST /api/prospects`
answers the plain view.

## Mail sequence — `/api/prospects/{prospect_id}/messages`

One durable message per prospect and step `contact` | `r1` | `r2` (H-20). No step ordering is enforced (R1 can be
prepared before the Contact mail is sent). Message statuses: `draft` (Brouillon), `validated` (Validé), `scheduled`
(Programmé), `sent` (Envoyé), `cancelled` (Annulé) — distinct from the prospect's state.

### State machine

```
(none) --PUT--> draft --validate--> validated --schedule--> scheduled --(dispatcher, S7)--> sent (immutable)
                  ^                     |  ^                    |
                  |                     |  +----unschedule------+
                  +------PUT (edit)-----+-----------------------+   edit => draft, revision+1, validation cleared
draft|validated|scheduled --cancel--> cancelled --reopen--> draft (revision+1)
```

- **Edit ⇒ revalidation** (H-24): saving a different content of a `validated`/`scheduled` message puts it back to
  `draft`, bumps `revision`, clears the validation and the send moment (`unvalidated: true`). An identical save
  changes nothing (`changed: false`).
- **AI provenance** (S5): a save that changes the subject or the body clears `generation_model`,
  `generation_prompt_version` and `generated_at` (the text is now the person's); a recipients-only edit keeps them. The
  audit event of that edit keeps the provenance (the fields' before values).
- **Validation** (H-23) confirms the current revision (`validated_revision = revision`), by a person, one message at a
  time; it needs `from_email`, at least one `to`, a subject and a body (else 422 `message_incomplete` + `fields`).
- **Schedule** (H-25): from `validated` only, an explicit ISO 8601 moment **with offset**, strictly in the future and
  at most one year ahead; no default time, unrelated to the next-action week (H-14). **Unschedule** keeps the validation.
- **Sent** is immutable (H-21: service + database trigger). Only the dispatcher sends (S7); the one route that marks
  a message sent is `mark-sent`, for a send the dispatcher could not confirm (a person found it in the mailbox).
- **Cancel** (a person, or decision 29 below) keeps the content; **reopen** brings a cancelled step back to `draft`.
- **Optimistic concurrency**: every change of an existing message sends the `expected_revision` it read.
  `revision` changes with the content (and a reopening), never with validate/schedule/unschedule/cancel.
- **Human actor** only (403 `human_actor_required`).
- **Closed sequence**: prospect state `response_received`, `appointment_obtained` or `ignored`, or the opposition
  `do_not_contact` — create, edit, validate, schedule and reopen are refused; unschedule and cancel stay possible.
- **Decision 29 and the opposition**: when a person (or an import) sets `response_received`, `appointment_obtained`
  or `ignored`, every `draft`/`validated`/`scheduled` message of the prospect is cancelled in the same transaction
  (`cancel_reason = "prospect_state:<state>"`). Recording the opposition `do_not_contact` (the editor's opposition, or the
  `ignored` state from any path) does the same with `cancel_reason = "do_not_contact"`; on the `ignored` path the state cancels
  first, so its messages carry `prospect_state:ignored`. `sent`/`cancelled` are untouched; a message claimed by the
  dispatcher (S7) is left to it and counted in `in_flight_messages`.

### Endpoints

| Method | Path | Body | Answer |
|---|---|---|---|
| GET | `…/messages` | — | `MessagesOut` |
| GET | `…/messages/{step}` | — | `{"message": Message \| null}` |
| PUT | `…/messages/{step}` | `MessageContentIn` | 201 (created) / 200 `MessageResult` |
| POST | `…/messages/{step}/validate` | `{"expected_revision": 1}` | `RemoteDraftResult` — see *CIRCOE Toolbox (S6)* |
| POST | `…/messages/{step}/schedule` | `{"expected_revision": 1, "scheduled_at": "2026-10-06T09:30:00+02:00"}` | `RemoteDraftResult` |
| POST | `…/messages/{step}/unschedule` | `{"expected_revision": 1}` | `MessageResult` |
| POST | `…/messages/{step}/cancel` | `{"expected_revision": 1}` | `MessageResult` |
| POST | `…/messages/{step}/reopen` | `{"expected_revision": 1}` | `MessageResult` |
| POST | `…/messages/{step}/generate` | `{"expected_revision"?: 1, "instruction"?: "…", "replace"?: true}` | 201 (created) / 200 `GenerationResult` — see *AI drafting (S5)* |
| POST | `…/messages/{step}/remote-draft` | `{"expected_revision": 1}` | `RemoteDraftResult` — « Réessayer » the Infomaniak draft (S6) |
| POST | `…/messages/{step}/mark-sent` | `{"expected_revision": 1}` | `MessageResult` — « Marquer envoyé » an unconfirmed send (S7) |
| POST | `…/messages/{step}/release` | `{"expected_revision": 1}` | `MessageResult` — « Remettre en Validé » an unconfirmed send (S7) |

`MessagesOut`:

```json
{
  "sequence": {"prospect_id": "…", "state": "contacted", "do_not_contact": false, "closed": false},
  "defaults": {"from_email": "prospection@exemple.example", "to": ["jean.test@exemple.example"], "generation_available": true,
               "toolbox_connected": false, "toolbox_state": "disabled", "automatic_sending_active": false,
               "dispatch_reason": "toolbox_disabled", "dispatch_max_lateness_minutes": 360, "dispatch_claim_ttl_seconds": 600},
  "steps": [{"step": "contact", "message": null}, {"step": "r1", "message": null}, {"step": "r2", "message": null}]
}
```

`defaults.from_email` = `VIPER_DEFAULT_OUTBOUND_EMAIL` (null when unset), `defaults.to` = the primary e-mail,
`defaults.generation_available` = the AI drafting is configured (`VIPER_OPENAI_API_KEY` and `VIPER_OPENAI_MODEL`),
`defaults.toolbox_connected` = the CIRCOE Toolbox is enabled, configured and connected (S6), `defaults.toolbox_state`
= its state (`disabled`, `not_configured`, `disconnected`, `connected`, `expired`), `defaults.automatic_sending_active`
= a scheduled message really leaves (S7: the dispatcher runs in this API process and the Toolbox is connected),
`defaults.dispatch_reason` = why not (S9, the `reason` of the dashboard's `dispatch`, null when active), with
`dispatch_max_lateness_minutes` and `dispatch_claim_ttl_seconds`.

`MessageContentIn` (unknown fields refused): `expected_revision` (omitted/null = create the step's message; else the
revision read), `from_email` (null clears it), `subject` (≤ 998), `body_text` (≤ 100 000), `to`, `cc`, `bcc` (lists of
≤ 50 addresses; blanks dropped, lowercased, deduplicated — also across lists: an address is kept in the first of
`to` > `cc` > `bcc`). Control characters (CR, LF, NUL…) are refused in `subject` and the addresses (header
injection); the body is free text. An omitted field keeps its value — or, on creation, the default (`from_email`,
`to`) or empty. An identical save answers `changed: false`, even on a closed sequence.

`MessageResult`: `{"message": Message, "created": bool, "changed": bool, "unvalidated": bool}`.

`Message`: `id`, `prospect_id`, `step`, `status`, `from_email`, `to`, `cc`, `bcc`, `subject`, `body_text`,
`revision`, `validated_revision`, `validated_at`, `validated_by` (display name), `scheduled_at`, `sent_at`,
`cancelled_at`, `cancel_reason` (`manual` | `prospect_state:<state>` | `do_not_contact`), `generation_model`,
`generation_prompt_version`, `generated_at` (S5), `has_remote_draft` (S6), `dispatch_claimed_at`, `dispatch_attempts`
(S7), `last_error_code`, `last_error_at` (S6: a `toolbox_*` code when the Infomaniak draft of the validated revision
could not be created; S7: the `send_*` / `dispatch_*` codes of [§ Scheduled sending](#scheduled-sending-s7)),
`created_at`, `updated_at`.

### Refusal codes

| HTTP | `code` | When | Extra |
|---|---|---|---|
| 404 | `not_found` | unknown prospect | |
| 404 | `message_not_found` | action on a step never created; `PUT` with a revision on a missing step | |
| 409 | `message_exists` | `PUT` without `expected_revision` on an existing step | |
| 409 | `revision_conflict` | `expected_revision` ≠ current revision | |
| 409 | `message_sent_immutable` | any change of a sent message | |
| 409 | `message_cancelled` | edit of a cancelled message (reopen it first) | |
| 409 | `invalid_transition` | action not allowed from the current status | `status` |
| 409 | `dispatch_in_progress` | message claimed by the dispatcher (S7) | |
| 409 | `dispatch_not_unconfirmed` | `mark-sent` / `release` of a message whose send is not unconfirmed (not claimed, or still running) | |
| 409 | `dispatch_release_too_early` | `release` before the claim is older than the TTL | `available_at` |
| 409 | `prospect_do_not_contact` | write on a do-not-contact prospect | |
| 409 | `prospect_sequence_closed` | write after `response_received` / `appointment_obtained` / `ignored` | |
| 422 | `message_incomplete` | validate without from/to/subject/body | `fields`: `from_email`, `to`, `subject`, `body_text` |
| 422 | `invalid` | bad address (`field`: `from_email`, `to.1`, `cc.0`…; `reason` `format`/`too_many`/`control_character`), control character in `subject` (`reason: control_character`), send moment in the past (`field: scheduled_at`, `reason: not_future`) or more than a year ahead (`reason: too_far`) | `field`, `reason` |
| 403 | `human_actor_required` | not a person, or a person without an id | |
| 503 / 409 | `toolbox_not_configured` / `toolbox_not_connected`, `toolbox_auth_expired` | `…/remote-draft` without a usable Toolbox (S6) | |

## AI drafting (S5) — `POST …/messages/{step}/generate`

The AI only **writes the subject and the body** (H-22, H-26): the result is always a `draft` that a person reviews,
edits and validates; nothing is validated, scheduled or sent, and the prospect's state never changes. Port of the
reference `src/server/contactMailGenerationService.ts`, `openaiMailGenerator.ts`, `mailGenerationPrompt.ts`.

| Module | Role |
|---|---|
| `app/services/mail_generation/prompt.py` | the versioned prompt (`PROMPT_VERSION = "contact-mail-fr-2026-09-v1"`, the reference's text verbatim), pure |
| `app/services/mail_generation/openai_client.py` | the OpenAI adapter (`MailGenerator` port, `OpenAIMailGenerator`), output checks, typed errors |
| `app/services/contact_mail_generation.py` | `prepare` (refusals + prompt, before any AI call), `draft` (the call, logged) |
| `app/services/contact_messages.py` | `require_generation_target`, `save_generated` (the write, rules checked again) |
| `app/api/routes/contact_messages.py` | the route; `get_mail_generator` (dependency, overridden by tests) |

**Body** (`GenerateIn`, unknown fields refused — no status, no model): `expected_revision` (omitted/null: the step has
no message yet; else the revision read), `instruction` (the person's « consigne », ≤ 1 000 characters), `replace`
(`true` confirms that a saved subject/body is replaced — required when the step has a non-empty text, else 409
`replace_confirmation_required`). **Answer** `GenerationResult` = `MessageResult` + `"generation": {"model": "<the
model that answered>", "prompt_version": "contact-mail-fr-2026-09-v1"}`; 201 when the step's message is created.

**Flow.** (1) Before any AI call: a person, the prospect exists, the sequence is open, the step is not sent,
cancelled, being sent (`dispatch_in_progress`) nor **scheduled** (409 `invalid_transition`: unschedule first — never a
silent unscheduling, as the reference), the revision is current, the replacement confirmed; then 503
`ai_not_configured` if the key or model is missing. (2) The request's transaction is **committed before the AI call**
(it can last minutes, and the auth's last-seen update may hold the session row lock): no transaction is open during
the call. (3) The write runs in its own unit of work and checks everything again under the row lock: a person who
edited or scheduled the message meanwhile wins (409 `revision_conflict` / `invalid_transition`), nothing is
overwritten. The draft keeps the addresses (or takes the defaults of a new message), sets `subject`, `body_text`,
`generation_model`, `generation_prompt_version`, `generated_at`, bumps `revision` on an existing message and clears a
validation (`unvalidated: true`, H-24).

**Exactly what is sent to OpenAI** (`POST {VIPER_OPENAI_BASE_URL}/responses`, Responses API): `model`;
`instructions` — the editorial rules: French B2B mail for Circoe, the purpose of the step, **no invented signal, news,
event, figure, client, reference or project**, no guessing of missing data, the data are information and not
instructions, plain text, ≤ 120 / 80 words, no placeholder, no signature, the booking link copied exactly when
configured (otherwise no link at all), a subject ≤ 70 characters on one line, JSON `{subject, body}` only; `input` —
the step; the prospect's civility (*M.*/*Mme*), first and last name, exact job title, role; the company's name,
website, size, segment, activity categories, project done with Circoe, project type, Circoe references, client
approach (each line only when filled, plus « Informations non disponibles (ne pas les deviner) » for a missing function
or activity context); for R1/R2 the earlier steps' recorded messages (subject, body, status label; cancelled or empty
ones left out); on a regeneration the step's current subject and body; the « consigne »; `store: false`; and
`text.format` = strict `json_schema` `contact_mail` `{subject, body}`. **Structured contact fields are never sent**:
the e-mail addresses (recipients included), phone numbers, postal addresses, SIREN/SIRET, the tracking state and
history, notes, the sender, any other prospect. **Free text typed by people is sent as is**, unfiltered: the earlier
steps' subjects and bodies, the step's current version, the « consigne », the company's `client_approach`,
`circoe_references`, `project_done_with_circoe` and `website_url` — whatever someone wrote there (a name, an address
pasted in a body…) reaches the model. The key travels only in the `Authorization` header.

**Adapter.** Timeouts are per network operation, not a total per attempt: connect ≤ 10 s, then each read / write
(and the wait for a pooled connection) ≤ `VIPER_OPENAI_TIMEOUT_MS` — a slow answer that keeps sending bytes can last
longer. A timeout is not replayed (504 `ai_timeout`); network errors, 408/409/429 (except `insufficient_quota`) and 5xx are retried `VIPER_OPENAI_MAX_RETRIES`
times with exponential backoff (0.5 s, 1 s, … ≤ 10 s; `Retry-After` honoured and capped). The output is checked before
anything is written: a JSON object with exactly `subject` and `body` (strings), subject 1–200 characters on one line
without control characters, body 1–10 000 characters (line breaks and tabs only), **no field left to complete**
(`[…]`, `{…}`, `<…>`, `XXX`), **no link but the configured booking link** (also accepted right inside « »
guillemets) and **no e-mail address** outside that link (VIPER sends none: a link or an address would be a fact it
does not hold) — the last three are server guardrails beyond the reference's schema check. The
model recorded is the one OpenAI names in its answer (snapshot), else the configured one.

| HTTP | `code` | When |
|---|---|---|
| 503 | `ai_not_configured` | key or model unset (the message names the missing `VIPER_OPENAI_*`) |
| 504 | `ai_timeout` | no answer within the timeout |
| 429 | `ai_rate_limited` | rate limit after the retries, or quota exhausted (`insufficient_quota`, not retried) |
| 502 | `ai_auth_failed` | key refused (401/403) |
| 502 | `ai_upstream_error` | other provider failure, unreachable service, adapter crash |
| 422 | `ai_refused` | the model refused to write |
| 502 | `ai_invalid_output` | incomplete, unreadable or out-of-bounds output, placeholder, link not provided |
| 409 | `replace_confirmation_required` | a saved text without `replace: true` |

Plus the message codes (`not_found`, `message_not_found`, `message_exists`, `revision_conflict`,
`message_sent_immutable`, `message_cancelled`, `invalid_transition` with `status`, `dispatch_in_progress`,
`prospect_do_not_contact`, `prospect_sequence_closed`, `human_actor_required`) and FastAPI's 422 for the body. A
failure writes nothing (no message, no audit event). Logs (`mail_generation.started|succeeded|failed|retry`) carry the
prospect id, step, code, upstream HTTP status and error type, model and duration — never the key, the prompt, the
answer or an address.

## CIRCOE Toolbox (S6) — Infomaniak drafts of validated messages

Port of the reference `src/server/toolboxAuth.ts`, `toolboxMcpClient.ts`, `toolboxIntegration.ts` and the remote-draft
parts of `contactMessageService.ts` (handoff Task 15, decision 25, `references/toolbox-capabilities.md`). **Off by
default** (`VIPER_TOOLBOX_MAIL_ENABLED=false`): disabled, not configured or not connected, every message stays in VIPER
exactly as before S6 and nothing leaves the server. Tests and E2E use local fakes only (Contact port P6). Connection,
OAuth and token storage: [`settings-connections.md`](settings-connections.md).

| Module | Role |
|---|---|
| `app/services/toolbox/oauth.py` | OAuth 2.1 client (discovery, dynamic registration, PKCE S256, state, token, expiry) |
| `app/services/toolbox/token_store.py` | the token file (outside the database and the checkout, `0600`, atomic writes) |
| `app/services/toolbox/mcp_client.py` | MCP mail client (`MailToolbox` port, `McpMailToolbox`), typed errors |
| `app/services/toolbox/errors.py` | the `toolbox_*` codes and their HTTP status |
| `app/services/toolbox/integration.py` | the per-process integration (`app.state.toolbox`): settings, state, `mail_toolbox()` |
| `app/services/toolbox/worker.py` | the cleanup worker thread of the API process |
| `app/services/contact_remote_drafts.py` | queueing, creation after validation, the deletion queue pass |
| `app/api/routes/toolbox.py` | `/api/settings/toolbox` (status, connect, callback, forget) |

### Lifecycle of a remote draft

A remote draft belongs to the **validated revision** (handoff docs/07 « Usage recommandé »): none for a draft, none
for an AI generation.

- **Validate** (and **schedule** a message that has none) → after the local commit, `infomaniak.mail.create_draft`
  with `to`/`cc`/`bcc`/subject/body (**no `from`**: the Toolbox has none, the sender is the default mailbox of the
  Infomaniak account behind the connection) → `remote_provider = circoe_toolbox`, `remote_draft_id` set
  (`has_remote_draft: true`), audit `contact_message.remote_draft_created` (history *Brouillon créé dans Infomaniak*).
  The attach re-reads the message under a row lock and only attaches to the same validated revision; a draft made for
  a revision that changed meanwhile is queued for deletion (`replaced`, answer `stale`).
- **Edit** of a validated/scheduled message, **AI redraft**, **cancel** (a person, decision 29, the opposition) →
  the old id is queued in `contact_message_remote_draft_cleanups` (`edited` / `cancelled`) **in the same transaction**
  and detached (`_clear_validation`, `cancel_message` → `detach_remote_draft`). Re-validating creates a new draft: the
  Toolbox has no update tool, so « replace » = delete the old one + create a new one (as the reference).
- **Deletion queue** (migration `0010`): after commit, `process_cleanups` calls `infomaniak.mail.delete_draft` for the
  due entries — the worker every `VIPER_TOOLBOX_CLEANUP_INTERVAL_MS`, woken right after a successful write under
  `/api/prospects`, or `python -m app.cli toolbox-cleanup --once`. An already-gone draft counts as done
  (`outcome = already_absent`); an id attached to a message again is never deleted (`still_attached`); a failure is
  retried with backoff (30 s, doubling, at most 6 h; `attempts`, `last_error_code`, `next_attempt_at`); a connection
  problem (`toolbox_not_connected`, `toolbox_auth_expired`, `toolbox_not_configured`) stops the pass without counting
  an attempt (a tool-level refusal is also recorded on the connection: Settings says *À reconnecter*). Each entry is
  **claimed** (row taken with `FOR UPDATE SKIP LOCKED`, `next_attempt_at` pushed one 10-minute lease ahead,
  committed), then deleted **outside any transaction**, then the outcome is recorded: the API's worker and a CLI pass
  never take the same entry, and a pass that dies mid-way leaves it due again after the lease (the delete is
  idempotent). Deleting the prospect keeps its queued ids (`message_id` set to NULL).
- **Deleted message** (prospect deleted from the editor, *Réinitialiser les données de prospection*, a Database
  Explorer row delete, any cascade or raw `DELETE`): the `BEFORE DELETE` trigger `queue_remote_draft_on_delete`
  (migration `0011`) queues its attached draft (`reason = deleted`, `message_id` NULL), whatever the path; a sent
  message is skipped (its draft left the mailbox when it was sent).

### Failure semantics (decided for S6)

The **human validation is the local truth** and is never rolled back by a Toolbox failure: the message stays
`validated`, without a remote draft; the failure code is recorded on it (`last_error_code = toolbox_*`,
`last_error_at`, audit `contact_message.remote_draft_failed`, history *Brouillon Infomaniak non créé*); the answer says
`remote_draft: {"status": "failed", "code": "toolbox_unavailable"}` and the editor shows *Brouillon Infomaniak non
créé : …* with **Réessayer** (`POST …/remote-draft`). Scheduling tries again; S7 recreates a missing draft before
sending (reference `syncRemoteDraft`). A later success, an edit or a cancellation clears that code. This is the
reference's behaviour (« un échec de création de brouillon laisse le statut intact »), made visible and durable.

**Unknown outcome** (QA rework): a `create_draft` that times out or gets a 5xx may have created the draft anyway. The
message then records `last_error_code = toolbox_outcome_unknown`; the next attempt (*Réessayer*, a schedule, S7)
first lists the mailbox's drafts (`list_drafts`, 100) and **attaches a draft with the same subject and the same `To`**
that no message holds and no cleanup entry names (the Toolbox returns no client reference and the reference adds no
VIPER marker, so these fields are the match); only if none is found is a new draft created (answer `recovered` vs
`created`). **S7** must apply the same rule before re-creating a missing draft, and never replay a `send_draft` whose
error has `outcome_unknown`.

A tool-level authentication refusal (`toolbox_auth_expired` from the Toolbox's text, e.g. no Infomaniak connection
for the member any more) marks the connection *à reconnecter* and records it as the last error, from any caller
(validation, *Réessayer*, the cleanup worker, the CLI).

`RemoteDraftResult` = `MessageResult` + `remote_draft: {status, code}`, `status` among `disabled` (Toolbox off or not
configured), `not_connected`, `not_applicable` (not validated/scheduled), `already_present`, `created`, `recovered`
(an unseen draft found and attached), `stale`, `failed` (+ `code`, `toolbox_outcome_unknown` included). The message in the answer is read again after the Toolbox call. The request's transaction is
committed before the Toolbox call (same pattern as the AI drafting).

### MCP client

JSON-RPC 2.0 over Streamable HTTP (`httpx2`, JSON or SSE answers): `initialize` → `notifications/initialized` →
`tools/call` per operation (the Toolbox is stateless), one total deadline (`VIPER_TOOLBOX_TIMEOUT_MS`). Tools and
arguments exactly as the Toolbox (commit 60ad176): `infomaniak.mail.create_draft {to[1..50], cc?, bcc?, subject
1..500, text 1..200000}` (bounds checked before any call: 422 `toolbox_invalid_input`), `delete_draft {draftId}`
(idempotent), and for S7 `send_draft {draftId}` and `list_drafts {limit 1..100}` (implemented and tested against the
fake, not called by S6). A tool error is `isError` + a French text, classified by pattern and **never kept or logged**
(it may quote an address). A 401 refreshes once when the server offers a refresh token (the Toolbox does not), else
marks the connection *à reconnecter*. Logs: tool name and duration, codes and upstream status only.

Codes (`ToolboxError`, with `retryable` and `outcome_unknown`):

| HTTP | `code` | Meaning |
|---|---|---|
| 503 | `toolbox_not_configured` | disabled or a setting missing (the message names the variables, never a value) |
| 409 | `toolbox_not_connected` | nobody connected, or the connection was forgotten |
| 409 | `toolbox_auth_expired` | the 30-day token ended, or the Toolbox refused it (401/403) |
| 502 | `toolbox_unavailable` | network error, 5xx/429/408, Infomaniak 5xx (`retryable`) |
| 504 | `toolbox_timeout` | no answer within the deadline (`retryable`; `outcome_unknown` for a `send_draft`) |
| 502 | `toolbox_invalid_response` | unreadable JSON-RPC or tool result |
| 422 | `toolbox_rejected` / `toolbox_outbound_blocked` / `toolbox_invalid_input` | refused by the Toolbox (its allowlist for `outbound_blocked`) or by the local bounds |
| 404 | `toolbox_draft_not_found` | `send_draft` of a gone draft (a delete of a gone draft is a success) |

### Limitations (handoff FINAL_REPORT) — accepted by the Human on 2026-10-01 for the pilot

- No `from`: the real sender is the default mailbox of the Infomaniak account behind the connection (the editor says
  so under *De* when the Toolbox is connected); `VIPER_DEFAULT_OUTBOUND_EMAIL` still fills *De* for the record.
- The token lasts 30 days without refresh: reconnect at expiry (Settings shows the end date; the tab is flagged
  *À reconnecter*).
- One server-side connection for the whole VIPER (whoever connected it).
- No remote revocation: « Oublier » deletes the token on VIPER's side only; it expires by itself.
- No Message-ID from `send_draft`: `remote_message_id` stays null; a send is proven by the Toolbox's answer (or, when
  it is lost, by the draft leaving the mailbox).
- The Toolbox names no mailbox in its answers: `account_label` stays null.

## Scheduled sending (S7)

Port of the reference `src/server/contactMessageDispatcher.ts` (handoff Task 16, decisions 10, 21-25, 29; decision
log C-24 … C-27). VIPER owns the schedule (`scheduled_at`, chosen by a person, decision 25); the dispatcher calls the
Toolbox's `infomaniak.mail.send_draft` on the message's Infomaniak draft once it is due. **Only the message's status
changes** (`scheduled` → `sent`, or back to `validated` for a person to review): the prospect's state never moves, the
cadence stays a suggestion (H-10, H-11) — after a send, a person chooses *Contacté* (or R1, R2) and applies the
suggested week if they want it.

| Module | Role |
|---|---|
| `app/services/contact_dispatch.py` | `Dispatcher.run_pass` (one pass), the codes, `mark_sent` / `release` (a person settles), `hold_scheduled` (post-restore safeguard), `dispatch_counts` |
| `app/services/contact_dispatch_worker.py` | `ContactDispatcher`: the daemon thread of the API process, one pass at a time, `status()` |
| `app/services/integration_runtime.py` | started once the Toolbox is connected — at startup (the lifespan) when it already is, or right after the OAuth return — when the sending is switched on (`contact_dispatch_enabled`, default true) with an interval > 0 (default 30 s, S9); restarted when these settings change; stopped gracefully (the running pass finishes) |
| `app/services/contact_dispatch_state.py` | `sending_reason` / `dispatch_state` (S9): active or why not, and the scheduled / overdue counts |
| `app/cli.py` | `python -m app.cli contact-dispatch --once` (one pass, prints its counts; exit 1 without a usable Toolbox) and `--hold-scheduled` |

### One pass

A pass does nothing while the Toolbox is disabled, not configured or not connected (no message is touched: no
overdue processing either — a reconnection then applies the lateness rule).

1. **Stale claims** — `scheduled` messages whose `dispatch_claim_id` is older than the claim TTL and not being sent by
   this process (killed process, unknown outcome, `sent` not recorded): one `list_drafts` (100) decides, never a blind
   resend.
   - the draft is gone and the listing is complete (< 100) → `sent`, `last_error_code = send_reconciled_draft_absent`
     (« envoyé (déduit) »);
   - the draft is still in the mailbox and **a send outcome was recorded** (`send_outcome_unknown`,
     `send_reconcile_inconclusive`, `send_probably_sent`) → **back to Validé** with `send_not_confirmed` (« envoi non
     confirmé, brouillon toujours présent : vérifiez les éléments envoyés puis reprogrammez »): an unknown outcome is
     **never retried automatically** (C-25, as the reference);
   - the draft is still in the mailbox and the claim has **no recorded outcome** (its process died around
     `send_draft`) → released for a new attempt (`send_not_confirmed`, backoff; back to Validé once `max_attempts`
     are spent; the lateness rule still bounds it). If that retry then finds the draft gone (`draft_not_found`), the
     dead process probably sent it: the claim is kept (`send_probably_sent`), deduced sent by the next reconciliation
     or settled by a person — never back to Validé;
   - the listing is full (truncated) or unreadable, or the message holds no draft id → the claim stays
     (`send_reconcile_inconclusive`), retried at every pass; a person can settle it.
2. **Due messages** (`scheduled`, `scheduled_at` ≤ now, unclaimed; oldest first, Contact before R1 before R2 at the
   same moment; 100 per pass). For each, under its row lock (`SKIP LOCKED`: a person writing it meanwhile wins, next
   pass):
   - **closed sequence** (`response_received`, `appointment_obtained`, `ignored`, `do_not_contact`) → decision 29:
     the prospect's unsent, unclaimed messages are cancelled (`prospect_state:<state>` / `do_not_contact`), nothing
     leaves;
   - **too late** (`now - scheduled_at` > max lateness, 6 h) → back to Validé, `dispatch_overdue`: never a late send;
   - **backoff** after a failed attempt (`retry_base` × 2^(attempts-1), ≤ 1 h) → next pass;
   - **recipients**: no `To` → `send_missing_recipients`; a `To`/`Cc`/`Cci` outside `VIPER_INFOMANIAK_SEND_ALLOWLIST`
     (when set) → `send_recipient_not_allowed`; both back to Validé;
   - **step order** (C-24): R1 (R2) never leaves while the Contact (R1) message of the same prospect is prepared but
     unsent: it **waits** while that one is scheduled at or before it (it leaves first — or its own outcome decides),
     and goes back to Validé with `send_previous_step_pending` when the previous one is a draft, validated, or
     scheduled later. An absent or cancelled previous message does not block (a first contact made outside VIPER, e.g.
     an imported « Contacté »);
   - **no Infomaniak draft** (validated while the Toolbox was off, creation failed) → created now
     (`sync_remote_draft`, with S6's `list_drafts` recovery after a `toolbox_outcome_unknown`); a failure counts an
     attempt and keeps its `toolbox_*` code (retry), or goes back to Validé with `send_draft_not_created` when
     definitive or the attempts are spent;
   - **claim**: one short transaction; the prospect and its tracking are share-locked **first** (the lock order of
     the state changes and the opposition, which lock the prospect then its messages: no deadlock — QA probe turned
     into a test), then the message row; every condition is checked again (still `scheduled`, due, unclaimed, the
     validation is the current revision, a draft attached, recipients, allowlist, step order) and the state and
     opposition are read under those locks (a concurrent state change waits for the claim, then finds the message in
     flight — `in_flight_messages`). A lock conflict PostgreSQL still aborts (deadlock, lock timeout) leaves the
     message for the next pass (`contact_dispatch.lock_conflict`, a warning, no traceback); `dispatch_claim_id` (new UUID), `dispatch_claimed_at`, `dispatch_attempts` + 1,
     audited `contact_message.dispatch_claimed`, committed;
   - **`send_draft`** outside any transaction;
   - **success** → `sent`, `sent_at`, `remote_message_id` null (the Toolbox returns none), audited
     `contact_message.sent` (reason `confirmed`). If `sent` cannot be recorded (database down), the claim stays and the
     reconciliation concludes from the draft's absence;
   - **certain failure** (refused before anything left): transient (`toolbox_unavailable`, `toolbox_timeout` at
     `initialize`, `toolbox_not_connected`, `toolbox_auth_expired`, `toolbox_not_configured`) → claim released,
     `send_<code>`, retry after the backoff, at most `max_attempts`; definitive (`toolbox_rejected`,
     `toolbox_outbound_blocked`, `toolbox_invalid_input`, `toolbox_draft_not_found` — the draft id is then dropped) or
     attempts spent → back to Validé with the code. Then, if the sequence closed during the call, the message is
     cancelled (the state change had left it to the dispatcher);
   - **unknown outcome** (timeout or 5xx during `send_draft`, a Toolbox error text no pattern recognises — e.g.
     « terminated » —, a non-JSON or unreadable answer, MCP error, unexpected exception) → the claim is **kept**,
     `send_outcome_unknown`: never resent automatically; after the TTL the reconciliation deduces the send (draft
     gone) or puts it back to Validé (draft present), or a person settles it. Only a *recognised* refusal (allowlist,
     draft not found, invalid input, authentication) counts as « nothing left ».

**Exactly once.** A `send_draft` needs a claim won under the row lock with every condition re-checked — two passes,
threads or processes never both claim (tested with two database sessions); a claim is released for a new attempt
only after a *certain* failure, or by a reconciliation that still sees the draft of a claim **without** a recorded
outcome; an unknown outcome is never retried; `sent` is immutable (trigger
`reject_sent_change`). Only a validated message of the **current** revision is ever sent: an edit puts it back to
draft and detaches (queues for deletion) its draft, so the old revision's draft can never be the one sent.

### A person settles an unconfirmed send

An unconfirmed send = claimed with `send_outcome_unknown` / `send_reconcile_inconclusive` / `send_probably_sent`, or a
claim older than the TTL (its process died). A send still running is never settled (409 `dispatch_not_unconfirmed`).
*Marquer envoyé* is open as soon as the send is unconfirmed; *Remettre en Validé* only once the claim is older than
the TTL (409 `dispatch_release_too_early` with `available_at`): the Toolbox's own call to Infomaniak has no timeout,
so a send VIPER gave up on may still be finishing — rescheduling it then could send it twice. The editor shows the
button disabled with *« Remettre en Validé » possible à partir de …*.

| Route | Effect |
|---|---|
| `POST …/messages/{step}/mark-sent` `{expected_revision}` | *Marquer envoyé* — the person found the mail in the mailbox's sent items: `sent`, `send_marked_by_person`, audited `contact_message.sent` (reason `person`) |
| `POST …/messages/{step}/release` `{expected_revision}` | *Remettre en Validé* — the person checked it did not leave: `validated` (validation and Infomaniak draft kept, no send moment), `send_released_by_person`, audited `contact_message.dispatch_released`; cancelled at once if the sequence has closed |

Both: a person only (403 `human_actor_required`), 404 `not_found` / `message_not_found`, 409 `revision_conflict`,
`invalid_transition` (not scheduled), `dispatch_not_unconfirmed`; `release` also `dispatch_release_too_early`.

### Codes (`last_error_code`) and what the editor says

| Code | Where | Meaning |
|---|---|---|
| `send_unavailable`, `send_timeout`, `send_not_connected`, `send_auth_expired`, `send_not_configured` | scheduled (retry) / validated (attempts spent) | certain transient refusal of `send_draft` |
| `send_rejected`, `send_outbound_blocked`, `send_invalid_input`, `send_draft_not_found` | validated | definitive refusal |
| `send_outcome_unknown`, `send_reconcile_inconclusive` | scheduled, claimed | unconfirmed: locked, never resent automatically |
| `send_probably_sent` | scheduled, claimed | a retry found the draft gone: probably sent by the earlier attempt; deduced or settled, never back to Validé |
| `send_not_confirmed` | validated (unknown outcome, draft still present: check the sent items, then reschedule) / scheduled (retry of a claim without a recorded outcome) | reconciliation found the draft still there |
| `send_reconciled_draft_absent` | sent | « envoyé (déduit) » |
| `send_marked_by_person` / `send_released_by_person` | sent / validated | a person settled it |
| `dispatch_overdue` | validated | more late than the max lateness, not sent |
| `send_missing_recipients`, `send_recipient_not_allowed`, `send_previous_step_pending`, `send_draft_not_created` | validated | refused before any send |
| `dispatch_held` | validated | scheduling withdrawn by `contact-dispatch --hold-scheduled` (after a restore) |
| `dispatch_internal_error` | (log only, as the unknown outcome) | unexpected exception during the send |

`toolbox_*` codes stay the Infomaniak draft's (S6, `remoteDraftLine`); the UI never reads a `send_*` code as a
draft failure. A new schedule or an edit clears the code and the attempts.

### Read model

`MessagesOut.defaults` adds `automatic_sending_active` (the dispatcher runs in this process **and** the Toolbox is
connected: a scheduled message really leaves), `dispatch_reason` (S9: why not), `dispatch_max_lateness_minutes` and
`dispatch_claim_ttl_seconds`. The dashboard adds `dispatch` (S9, § Dashboard).
`Message` adds `dispatch_claimed_at` and `dispatch_attempts`. Settings › Connexions shows the dispatcher's state, last
pass and counts (`GET /api/settings/toolbox` → `dispatch`, [`settings-connections.md`](settings-connections.md)).

### Restore safeguard (handoff FINAL_REPORT recommendation 4)

VIPER has no restore command: backups are `pg_dump` (runbook). A backup taken before a send restores the message as
« Programmé »; started as is, the dispatcher would send it again (within the 6 h lateness window). The runbook
requires `python -m app.cli contact-dispatch --hold-scheduled` before starting the API on a restored database: every
scheduled, unclaimed message goes back to Validé (`dispatch_held`, audited `contact_message.unscheduled` by the CLI
actor); claimed ones are counted for a person to settle.

## Audit and privacy

Each message change is one audit event on the message, in the prospect's history: `contact_message.created`,
`.updated` (edit of a draft), `.unvalidated` (edit that cleared a validation), `.validated`, `.scheduled`,
`.unscheduled`, `.cancelled` (context `reason`: `manual`, `prospect_state:<state>` or `do_not_contact`), `.reopened`,
`.generated` (an AI draft, S5 — history title *Brouillon rédigé par l’IA*; the model and prompt version are in the
changes, the subject and body masked like any content), `.remote_draft_created` / `.remote_draft_failed` (S6, the
Infomaniak draft of the validated revision; the failure's `toolbox_*` code in `context.reason`),
`.dispatch_claimed` / `.sent` (reason `confirmed`, `reconciled` or `person`) / `.dispatch_failed` (the code in the
reason) / `.dispatch_released` (S7; history titles *Envoi lancé*, *Message envoyé*, *Envoi non effectué*, *Envoi non
confirmé, remis en Validé*). The dispatcher writes as the system actor `contact-dispatcher` (« Envoi programmé
VIPER ») with `context.source = dispatcher` (history: *Système · Envoi programmé*). Connecting and
forgetting the Toolbox are `toolbox.connected` / `toolbox.forgotten` (entity `toolbox_connection`, no token). The
cleanup queue is a technical table outside the audit (ids and codes only), read-only in the Database Explorer.
The content
(`from_email`, recipients, subject, body) is **masked** in the audit log (`[masked]`: it changed, never what it says)
and never logged. Application logs carry ids, step, status, revision and actor type only. There is no separate
message journal: the append-only audit log already records who, when, which transition and which revision.

## Configuration

`VIPER_DEFAULT_OUTBOUND_EMAIL` (optional): the sender pre-filled in a new message; unset → typed by hand (a message
cannot be validated without one). Validated at startup (`x@y` form).

AI drafting (S5), all optional — unset, the button is disabled and the route answers 503 `ai_not_configured`:

| Variable | Default | Meaning |
|---|---|---|
| `VIPER_OPENAI_API_KEY` | unset | OpenAI key (secret: never logged, never returned, never in the browser). A blank value counts as unset. |
| `VIPER_OPENAI_MODEL` | unset | Model id, **required when the key is set** (startup error otherwise). No default: chosen by the operator (handoff docs/08 §4). |
| `VIPER_OPENAI_BASE_URL` | `https://api.openai.com/v1` | API root (`/responses` is appended); tests and E2E point it at a local fake. |
| `VIPER_OPENAI_TIMEOUT_MS` | `60000` | Per network operation (each read / write; connect ≤ 10 s), 1 000–300 000. |
| `VIPER_OPENAI_MAX_RETRIES` | `2` | Retries on transient failures, 0–5. |
| `VIPER_OPENAI_TRUST_ENV` | `false` | `true`: the OpenAI calls honour the server's `HTTPS_PROXY`, `NO_PROXY`, `SSL_CERT_FILE`… (a corporate proxy or CA). Off: a direct connection the environment cannot redirect. |
| `VIPER_CONTACT_BOOKING_URL` | unset | Booking link the AI may copy into a mail; an `http(s)` URL (anything else is refused at startup). Unset: no link at all. |

CIRCOE Toolbox (S6), all optional — **set in Paramètres › Connexions since S8** (the variables are only
defaults; a value saved in the UI wins) — see [`settings-connections.md`](settings-connections.md):

| Variable | Default | Meaning |
|---|---|---|
| `VIPER_TOOLBOX_MAIL_ENABLED` | `false` | Feature flag. Off: nothing leaves VIPER. « Se connecter à CIRCOE Toolbox » turns it on, « Se déconnecter » off (S8). |
| `VIPER_TOOLBOX_MCP_URL` | the CIRCOE Toolbox (`https://circoetoolbox-server-production.up.railway.app/mcp`, S8) | Exact MCP URL (the OAuth resource the Toolbox announces); https, or http on localhost. Emptied: *non configurée*. |
| `VIPER_TOOLBOX_OAUTH_REDIRECT_URI` | unset | The SPA page `/settings/connections` as the browser sees it; https, or http on localhost. Unset: sent by the page when connecting (S8). |
| `VIPER_TOOLBOX_TOKEN_STORE_PATH` | `~/.viper/toolbox-oauth.json` | Token file; refused inside the checkout (startup error). |
| `VIPER_TOOLBOX_TIMEOUT_MS` | `20000` | Total bound of one Toolbox operation, 1 000–120 000. |
| `VIPER_TOOLBOX_CLEANUP_INTERVAL_MS` | `60000` | Cleanup worker period; `0` = no worker (CLI only). |
| `VIPER_INFOMANIAK_SEND_ALLOWLIST` | unset | VIPER-side recipient allowlist of the scheduled send (S7): addresses or `@domain`, comma-separated; parsed and validated at startup now (`Settings.send_allowlist`, `allowlist_permits`). |

A malformed URL or allowlist is a startup error; an unset URL while enabled is the *non configurée* state.

Scheduled sending (S7), names and defaults of the reference (`CONTACT_DISPATCH_*`):

| Variable | Default | Meaning |
|---|---|---|
| `VIPER_CONTACT_DISPATCH_ENABLED` | `true` (S9) | The switch *Envoi automatique des mails programmés* of Paramètres › Connexions; `false` = no worker (CLI only). |
| `VIPER_CONTACT_DISPATCH_INTERVAL_MS` | `30000` (S9; `0` in S8) | Dispatcher period in the API process, *Délai maximal avant envoi* in *Paramètres avancés*; `0` = no worker (CLI only). `1`-`499` refused. Runs only while the Toolbox is connected. |
| `VIPER_CONTACT_DISPATCH_MAX_LATENESS_MS` | `21600000` (6 h) | Beyond this lateness a message goes back to Validé (`dispatch_overdue`). 1 min – 7 days. |
| `VIPER_CONTACT_DISPATCH_CLAIM_TTL_MS` | `600000` (10 min) | Age after which a claim nobody finished is reconciled / settleable; never less than 2 × `VIPER_TOOLBOX_TIMEOUT_MS`. |
| `VIPER_CONTACT_DISPATCH_MAX_ATTEMPTS` | `5` | Attempts (claims and draft creations) of one schedule before going back to Validé. 1-20. |
| `VIPER_CONTACT_DISPATCH_RETRY_BASE_MS` | `60000` | Backoff base (× 2^(n-1), at most 1 h). |
| `VIPER_INFOMANIAK_SEND_ALLOWLIST` | unset | Enforced by the dispatcher: every `To`/`Cc`/`Cci` must match an address or `@domain` rule, else `send_recipient_not_allowed`. |

## Concurrency note

The prospect state is read without a lock by a message write. A state change committed meanwhile waits for the
message row lock and then cancels that message too; the only gap is a **creation** racing the change: the new draft
is invisible to the cancellation and remains — it cannot be validated, scheduled or edited afterwards (closed
sequence), only read or cancelled.

## Contact page (UI, Slice S4)

`/contact` (`frontend/src/contact/`), in the navigation as *Contact* (Mail icon); `/exploitation` redirects to it.
Visual pattern: `doc/design/design-system.md` § *Contact page*. API module: `frontend/src/api/contact.ts`.

### List view

| Part | Behaviour |
|---|---|
| Counters | `GET /api/contact/dashboard?q=` — group *Cette semaine*: *À traiter cette semaine* (the union), *Premier contact*, *Relances*, *Revues R2*; group *Résultats*: *RDV pris*. Each card is a toggle filter (`aria-pressed`, check mark): it sets `counter`, puts the week on *Toutes les semaines* and the state on *Tous les états*, so the list equals the card (overdue weeks included); pressing it again returns to the default. A card never changes a state. |
| Toolbar | Search (debounced, `q` in the URL, also narrows the counters); *Semaine*: *Cette semaine (S40)* by default — the page sends the dashboard's `current_week` (the API has no default week; the list waits for it) —, the weeks of `weeks` (*S42 · lun. 12 oct. 2026 (3)*), *Toutes les semaines*; *État*: every Contact state but *Ignoré*. |
| Heading | The counter's label (or *Planning de contact*), the total, and one sentence of what the list holds. *Réinitialiser* when anything narrows it. |
| Rows | Compact person cards: initials, name (the card's link), role · title, company · primary e-mail (or *Pas d'e-mail principal*); the state badge (none for *Aucun état*) and the week badge, *Échu* when a follow-up's week is past; *À préparer : Premier contact / Relance R1 / Relance R2 / Revue après R2* (`next_step`); the three messages' statuses (*Contact Envoyé · R1 Brouillon · R2 Vide*), or *Aucun message préparé*. ↑/↓/Home/End move between people. |
| URL | `counter`, `week` (`all` or `2026-W41`; absent = this week), `state`, `q`, `page`, `prospect` (`contact/criteria.ts`); malformed values fall back to their default. Pages of 50. |
| States | Loading line, counters or list failure with the server's message and *Réessayer*, empty week (*Aucun prospect planifié cette semaine…*, or — when « À traiter » still counts people of past weeks — *… N prospects de semaines passées restent à traiter* with *Voir « À traiter cette semaine »*) vs no match. A URL week equal to the current one shows as *Cette semaine*. |

### Workbench (`?prospect=<id>`)

Opens **in place of the list** (decision 19: not the Prospection drawer), the focus on the sheet's heading (also after
*Précédent* / *Suivant*). *Retour à la liste* and browser Back are the same move: opened from the list, it goes back to
the list's history entry (focus on the person); opened from a link, it replaces the entry. *Précédent* / *Suivant*
replace their entry and walk the **whole list order**, read once (every page, `useContactWalk`) when the workbench
opens and kept while it stays open — past row 50, and unchanged when a save moves the person out of the filtered list
(*50 sur 60*); a prospect not in that order stays open with *Hors de la liste affichée*. The sheet and the mail sequence
load in parallel.

- **Left — prospect sheet** (`ProspectSheet.tsx`, read-mostly, `GET /api/prospects/{id}`): name, civility, role ·
  title, company and city, state / week / *Ne pas contacter* badges (and the opposition reason), active e-mails with
  *Principal* and their verification, phones; *Ouvrir dans Prospection* (`/prospection?prospect=<id>`) to correct the
  record. **Suivi de contact** (`TrackingPanel.tsx`): *État* (the eight states, disabled once *Ignoré*) and S2's week
  planner (cadence proposal included), saved together by *Enregistrer le suivi* through `PATCH …/tracking` — only
  what changed is sent: the state if chosen, the week if a person chose one (a week-clearing state without a chosen
  week lets the server clear it; the planner already shows it cleared; *Ignoré* never carries a week). *Réponse reçue*,
  *RDV pris* and *Ignoré* ask for a confirmation first (unsent messages cancelled, week removed, *Ignoré* final). The
  answer is said: *Suivi enregistré. 2 messages non envoyés annulés.*, plus a warning when `in_flight_messages` > 0
  (already leaving, may still go). A version conflict reloads the sheet.
- **Right — mail sequence** (`MailSequence.tsx`, `MailEditor.tsx`, rules in `mailModel.ts`): tabs *Contact / R1 /
  R2* (shared `Tabs` primitive), each with its status badge (*Vide*, *Brouillon*, *Validé*, *Programmé*, *Envoyé*,
  *Annulé*); the tab of the next step opens first (R1 after *Contacté*, R2 after *R1*). The editor: *De* (prefilled
  with `defaults.from_email`), *À* (prefilled with the primary e-mail), *Cc*, *Cci* (several addresses separated by
  commas; De and À each on a full row, Cc and Cci side by side), *Objet*, *Corps*; a status sentence that takes the focus
after a confirmed action (the action's button is gone); a status sentence (*Validé par … : prêt à être programmé.*, *Programmé pour le …*,
  *Annulé le … (passage à « Réponse reçue »)*).

| Status | Actions (one primary) |
|---|---|
| none | *Créer le brouillon* (`PUT` without revision) |
| draft | *Enregistrer* (never validates) · *Valider…* (confirmation) · *Annuler le message…* |
| validated | *Programmer l'envoi*: date **and** time fields (browser time, no default, the chosen day's UTC offset shown; kept per step across tab switches) → *Programmer…* (confirmation) · *Enregistrer* · *Annuler le message…* |
| scheduled | *Déprogrammer* (keeps the validation) · *Enregistrer* · *Annuler le message…* |
| scheduled, taken by the dispatcher (S7) | read-only, no action while it is being sent; *Marquer envoyé…* · *Remettre en Validé…* (confirmations) once unconfirmed |
| sent | read-only, no action (*Message envoyé : il reste consultable…*) |
| cancelled | read-only; *Rouvrir* (back to draft) while the sequence is open |

Pending edits disable *Valider…* / *Programmer…* / *Déprogrammer* (they act on the saved version) and offer
*Abandonner les modifications*; editing a validated or scheduled message shows first that saving puts it back to
*Brouillon* (to validate and schedule again). A closed sequence (*Réponse reçue*, *RDV pris*, *Ignoré*) or an
opposition locks the editor with its reason; a scheduled message can still be unscheduled or cancelled. Scheduling R1
(R2) while Contact (R1) has not left shows a non-blocking reminder (also in the confirmation). Refusals use
`contact/messages.ts`: `message_incomplete` on its fields, `invalid` on the named address / subject / send moment,
the others as one sentence; codes meaning « the server's message differs » (`revision_conflict`, `message_exists`,
`message_sent_immutable`, `message_cancelled`, `invalid_transition`, `dispatch_in_progress`, sequence closed,
`message_not_found`) reload the sequence **and keep the unsaved text in the form**; after a revision conflict the
message says the next save will replace the saved version and offers *Voir la version enregistrée* (drops the local
text). FastAPI's own 422 (list `detail`: over 50 addresses, an address over 320 characters, a body over 100 000) reads
*Un champ dépasse la taille autorisée…*; the fields carry the same limits (`maxLength`, local check of 50 addresses).

**Will not leave (S9)** (`contact/dispatchCopy.ts`, `contact/DispatchWarning.tsx`). After the Human report of
2026-10-02 (a message scheduled while the sending was off never left, and nothing said so), an inactive sending is
said everywhere, in the warning tone of the DA (`contact-mail__banner`), always with the reason in plain words and a
link to `/settings/connections` named after the fix (*Activer l’envoi automatique*, *Connecter / Reconnecter /
Configurer CIRCOE Toolbox*): a **banner at the top of the Contact page** (`role="alert"`) when at least one message is
scheduled — « N messages programmés ne partiront pas : <raison>. M ont déjà dépassé leur heure : au-delà du retard
toléré, ils reviendront à « Validé » sans partir et devront être reprogrammés. »; in the editor, under the status
sentence of a scheduled message, a `StatusBadge` warning *Ne partira pas : envoi automatique désactivé* (or *: Toolbox
non connectée*, *: connexion Toolbox expirée*…) with *Envoi automatique inactif : <raison>. La date est enregistrée,
mais aucun mail ne part tant que ce n’est pas réglé dans Paramètres › Connexions.* and, once its time has passed, *S’il
ne peut pas partir dans les 6 heures qui la suivent, il reviendra à « Validé » sans partir.*; the same warning in the
*Programmer l’envoi* block before scheduling and in the schedule confirmation. A message that went back to Validé
because it was too late (`dispatch_overdue`) reads *Pas envoyé : l’heure prévue était dépassée de plus de 6 heures
quand l’envoi automatique a pu le traiter (envoi désactivé, Toolbox déconnectée ou serveur arrêté). VIPER n’envoie
jamais un mail en retard : le message est revenu à « Validé ». Choisissez une nouvelle date dans « Programmer
l’envoi » pour le reprogrammer.* — the *Programmer l’envoi* block is right there. The message the Human scheduled
on 2026-10-01 while the sending was off follows this path: at the first pass after the fix it is more than 6 h
late, goes back to « Validé » with `dispatch_overdue` and waits to be scheduled again (never sent late).

**Scheduled sending (S7)** (`dispatchState`, `dispatchLine`, `sendErrorLabel` in `mailModel.ts`). The schedule
confirmation follows `defaults.automatic_sending_active`: active — *Le mail partira automatiquement à cette date
depuis la boîte Infomaniak connectée à la Toolbox (le serveur VIPER doit être en marche).*, *S’il ne peut pas partir
dans les 6 heures qui suivent, il ne part pas et revient à « Validé ».*, *Vous pourrez le déprogrammer jusqu’à
l’envoi.*; inactive (S9) — the warning block below and *Programmer quand même* (scheduling stays possible). The status
sentence of a scheduled message reads *Programmé : le mail partira automatiquement le … depuis la boîte Infomaniak
connectée, déprogrammable jusqu’à l’envoi.* when active (and not yet taken by the dispatcher), else *Programmé pour le
…*. Under it, one dispatch line:
*Envoi en cours par la Toolbox…* (spinner, the editor locked); a failed attempt *Dernière tentative d’envoi échouée :
<raison>. Nouvel essai automatique.*; back to Validé *Envoi programmé non effectué : <raison>. Le message reste
validé : reprogrammez-le pour réessayer.* (overdue, allowlist, previous step, Toolbox refusals…); sent *Envoi déduit :
…* or *Envoi confirmé par une personne…*. An **unconfirmed** send shows a warning banner (*Envoi non confirmé : la
Toolbox n’a pas donné de réponse sûre. VIPER ne le renverra jamais de lui-même…*) with **Marquer envoyé…** (primary)
and **Remettre en Validé…**, each behind a confirmation (*Retour* focused; the release is the danger button and warns
that rescheduling a mail that did leave sends it twice). While the server sends and a message is due within 2 minutes
or claimed, the sequence is read again every 3 s (`dispatchWatchInterval`): *Envoyé* appears without a reload, and a
status changed by the server refreshes the list's message chips, the counters and the history, and is said by a
persistent live region (*Message Contact envoyé.*, *… revenu en Validé : envoi non effectué.*). Once past its time
without being taken, a message is read every 30 s; an unconfirmed or stuck send is not polled; the interval runs only
while the editor is open and the browser tab visible. Under a send in progress or unconfirmed, the *Brouillon créé
dans Infomaniak* line is hidden.

**AI drafting (S5)** (`AiDraft.tsx`, rules in `aiDraftModel.ts`), in the action bar's left side
(`.contact-mail__assist`): the secondary *Générer avec l’IA* (empty step) / *Régénérer avec l’IA* (a saved text) and
the ghost disclosure *Consigne* (`aria-expanded`) that opens *Consigne pour l’IA (facultatif)* (≤ 1 000 characters)
above the bar; the « consigne » and its disclosure are kept per step across tab switches. Hidden when the step cannot
be edited (sent, cancelled, closed sequence); disabled with its reason when `defaults.generation_available` is false
(*… pas configurée sur ce serveur …*), the message is scheduled (*déprogrammez-le avant de le régénérer*) or the AI is
writing another step (*L’IA rédige déjà le message Contact : attendez…* — one request at a time per sequence). A confirmation (*Régénérer le message Contact ?*, *Retour* focused) comes
first when a saved text, unsaved edits or a validation would be lost; it says the result stays a Brouillon, and closes
as soon as it is confirmed. While the AI writes: *L’IA rédige le message Contact…* with a live seconds counter, the editor read-only, and a sentence
saying that nothing changes before it arrives and that switching tabs is safe (the answer lands in the cache whatever
editor is shown); the browser stops waiting after 5 min (the server bounds its own wait) and reloads the sequence. The
result replaces the shown text and is announced (*Brouillon Contact rédigé par l’IA : relisez-le…*, plus *repassé en
Brouillon* after a validation); an AI text carries *Rédigé par l’IA — à relire avant de valider.* with the model and
prompt version as a muted monospace hint (*Rédigé par l’IA, modifié par vous : la mention disparaîtra à
l’enregistrement.* while the subject or body is being rewritten). Accessibility: an always-mounted live region says
when the AI starts, the editor's live region says the outcome; the clicked button turns disabled while it runs, so
the focus moves to the running block, then to the draft's status sentence once it has arrived. Every `ai_*` code has its French sentence saying that nothing was changed;
the message codes reuse `contact/messages.ts`.

**CIRCOE Toolbox (S6)** (`remoteDraftLine` in `mailModel.ts`, from `defaults.toolbox_state`): under the status
sentence of a validated or scheduled message, one discreet line — *Brouillon Infomaniak non créé : Toolbox à
reconnecter.* (muted, no button) while the Toolbox is enabled but not connected or expired; *Brouillon créé dans Infomaniak.* (success-fg, check glyph); *Brouillon Infomaniak non
créé : <raison>.* (warning-fg, alert glyph; the `toolbox_*` code in French from `settings/toolboxCopy.ts`) with a ghost
**Réessayer** while the Toolbox is connected (*Création dans Infomaniak…* while it runs); *Brouillon Infomaniak pas
encore créé.* (muted) for a message validated before the connection. Nothing is said while the Toolbox is off (all
local, as before). When the Toolbox is connected, *De* carries the hint *Envoi réel depuis la boîte Infomaniak par
défaut du compte connecté à la Toolbox : ce champ n’est pas transmis.* The validation notice says *… validé et
brouillon créé dans Infomaniak* when it was; when the validation succeeded but the draft failed, the notice is a
warning (alert glyph) *Message … validé, mais le brouillon Infomaniak n’a pas été créé : <raison>. La validation est
conservée ; « Réessayer » le recrée.*, announced by the live region.

**Unsaved text**: kept per step — switching tabs loses nothing, a dot marks a tab with unsaved changes; leaving the
prospect (list, previous/next, Back, another page) with unsaved mail or follow-up asks *Modifications non
enregistrées* (*Rester sur ce prospect* / *Quitter sans enregistrer*); reload or close triggers the browser prompt.

**Refresh**: a message write replaces the step in the cache and re-reads the list (message chips), the counters and
the prospect's history; a prospect write (`useProspectMutations`, every path) also refreshes Contact (`contactKeys`)
and Home.

## Limitations (end of the port, S7)

All S3-S7 items are done; what remains is known and accepted for the pilot, or left to a later lot:

- **Never exercised for real**: OpenAI, the CIRCOE Toolbox and Infomaniak were only reached through local fakes (P6).
  The first real calls follow the runbook's step-by-step enabling (allowlist first).
- **Sender**: the default mailbox of the Infomaniak account behind the Toolbox connection; VIPER's *De* is indicative.
- **Toolbox connection**: one per server, 30 days, no refresh, no remote revocation. While it is not connected nothing
  leaves, and a scheduled message more than 6 h late goes back to « Validé » (said in the editor).
- **The draft is sent as it is in Infomaniak**: a change made in the webmail after the validation leaves with it
  (VIPER cannot see it).
- **Deduced send**: an unknown outcome whose draft has left the mailbox is « envoyé (déduit) »; a draft deleted by
  hand in the webmail meanwhile would be counted sent (no double send, a missed one is possible). No Message-ID.
- **A claim without a recorded outcome** (a process killed during `send_draft`) whose draft is still there after the
  TTL is retried: if Infomaniak ever kept a draft that was being sent, a double send would be possible (bounded by
  the lateness). Recorded unknown outcomes are never retried.
- **More than 100 drafts in the mailbox** make a reconciliation inconclusive: the message stays locked until a person
  settles it (*Marquer envoyé* / *Remettre en Validé*); *Envois non confirmés* in Settings counts them.
- **A state change during the `send_draft` round trip** cannot stop that send: it is reported (`in_flight_messages`)
  and the message is cancelled afterwards only if the send failed.
- **Step order**: R1/R2 refuse to leave before a prepared previous step; an absent or cancelled previous step does not
  block (a first contact made outside VIPER).
- **Restore**: VIPER has no restore command; the runbook's `contact-dispatch --hold-scheduled` must run before starting
  the API on a restored database.
- **One API process**: the dispatcher and the cleanup worker are threads of it; a second API instance is safe (claims)
  but doubles the passes. Polling of the editor (3 s) only while a send is imminent.
- Out of scope (V1): automatic state transitions after a send, bounce or reply reading, Calendly, attachments,
  signature/unsubscribe text (no model validated).
