# Contact — dashboard, mail sequence and the Contact page

Contact port, Slice S3 (handoff Tasks 09, 11, 12; decisions H-14 … H-29 of
`tasks/viper_contact_pipeline_handoff/docs/01-decision-log.md`) for the API, Slice S4 (Tasks 08, 10, 13) for the page
([§ Contact page](#contact-page-ui-slice-s4)), Slice S5 (Task 14) for the AI drafting
([§ AI drafting](#ai-drafting-s5--post-apiprospectsprospect_idmessagesstepgenerate)). States of a prospect and the next-action week are described in
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
  "weeks": [{"week": "2026-W52", "year": 2026, "number": 52, "count": 3}]
}
```

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
- **Validation** (H-23) confirms the current revision (`validated_revision = revision`), by a person, one message at a
  time; it needs `from_email`, at least one `to`, a subject and a body (else 422 `message_incomplete` + `fields`).
- **Schedule** (H-25): from `validated` only, an explicit ISO 8601 moment **with offset**, strictly in the future and
  at most one year ahead; no default time, unrelated to the next-action week (H-14). **Unschedule** keeps the validation.
- **Sent** is immutable (H-21: service + database trigger). No route marks a message sent.
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
| POST | `…/messages/{step}/validate` | `{"expected_revision": 1}` | `MessageResult` |
| POST | `…/messages/{step}/schedule` | `{"expected_revision": 1, "scheduled_at": "2026-10-06T09:30:00+02:00"}` | `MessageResult` |
| POST | `…/messages/{step}/unschedule` | `{"expected_revision": 1}` | `MessageResult` |
| POST | `…/messages/{step}/cancel` | `{"expected_revision": 1}` | `MessageResult` |
| POST | `…/messages/{step}/reopen` | `{"expected_revision": 1}` | `MessageResult` |
| POST | `…/messages/{step}/generate` | `{"expected_revision"?: 1, "instruction"?: "…", "replace"?: true}` | 201 (created) / 200 `GenerationResult` — see *AI drafting (S5)* |

`MessagesOut`:

```json
{
  "sequence": {"prospect_id": "…", "state": "contacted", "do_not_contact": false, "closed": false},
  "defaults": {"from_email": "prospection@exemple.example", "to": ["jean.test@exemple.example"], "generation_available": true},
  "steps": [{"step": "contact", "message": null}, {"step": "r1", "message": null}, {"step": "r2", "message": null}]
}
```

`defaults.from_email` = `VIPER_DEFAULT_OUTBOUND_EMAIL` (null when unset), `defaults.to` = the primary e-mail,
`defaults.generation_available` = the AI drafting is configured (`VIPER_OPENAI_API_KEY` and `VIPER_OPENAI_MODEL`).

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
`generation_prompt_version`, `generated_at` (S5), `has_remote_draft` (S6), `last_error_code`, `last_error_at` (S7),
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
| 409 | `prospect_do_not_contact` | write on a do-not-contact prospect | |
| 409 | `prospect_sequence_closed` | write after `response_received` / `appointment_obtained` / `ignored` | |
| 422 | `message_incomplete` | validate without from/to/subject/body | `fields`: `from_email`, `to`, `subject`, `body_text` |
| 422 | `invalid` | bad address (`field`: `from_email`, `to.1`, `cc.0`…; `reason` `format`/`too_many`/`control_character`), control character in `subject` (`reason: control_character`), send moment in the past (`field: scheduled_at`, `reason: not_future`) or more than a year ahead (`reason: too_far`) | `field`, `reason` |
| 403 | `human_actor_required` | not a person, or a person without an id | |

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
`text.format` = strict `json_schema` `contact_mail` `{subject, body}`. **Never sent**: e-mail addresses (recipients
included), phone numbers, postal addresses, SIREN/SIRET, the tracking state and history, notes, the sender, any other
prospect. The key travels only in the `Authorization` header.

**Adapter.** Timeout per attempt (`VIPER_OPENAI_TIMEOUT_MS`, connect ≤ 10 s); a timeout is not replayed (504
`ai_timeout`); network errors, 408/409/429 (except `insufficient_quota`) and 5xx are retried `VIPER_OPENAI_MAX_RETRIES`
times with exponential backoff (0.5 s, 1 s, … ≤ 10 s; `Retry-After` honoured and capped). The output is checked before
anything is written: a JSON object with exactly `subject` and `body` (strings), subject 1–200 characters on one line
without control characters, body 1–10 000 characters (line breaks and tabs only), **no field left to complete**
(`[…]`, `{…}`, `<…>`, `XXX`) and **no link but the configured booking link** (a link would be a fact VIPER does not
hold) — the last two are server guardrails beyond the reference's schema check; the prompt already forbids both. The
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

## Audit and privacy

Each message change is one audit event on the message, in the prospect's history: `contact_message.created`,
`.updated` (edit of a draft), `.unvalidated` (edit that cleared a validation), `.validated`, `.scheduled`,
`.unscheduled`, `.cancelled` (context `reason`: `manual`, `prospect_state:<state>` or `do_not_contact`), `.reopened`,
`.generated` (an AI draft, S5 — history title *Brouillon rédigé par l’IA*; the model and prompt version are in the
changes, the subject and body masked like any content).
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
| `VIPER_OPENAI_TIMEOUT_MS` | `60000` | Per attempt, 1 000–300 000. |
| `VIPER_OPENAI_MAX_RETRIES` | `2` | Retries on transient failures, 0–5. |
| `VIPER_CONTACT_BOOKING_URL` | unset | Booking link the AI may copy into a mail; an `http(s)` URL (anything else is refused at startup). Unset: no link at all. |

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
*Un champ dépasse la taille autorisée…*; the fields carry the same limits (`maxLength`, local check of 50 addresses). The confirmation of a schedule
says that automatic sending is not active yet (S7).

**AI drafting (S5)** (`AiDraft.tsx`, rules in `aiDraftModel.ts`), in the action bar's left side
(`.contact-mail__assist`): the secondary *Générer avec l’IA* (empty step) / *Régénérer avec l’IA* (a saved text) and
the ghost disclosure *Consigne* (`aria-expanded`) that opens *Consigne pour l’IA (facultatif)* (≤ 1 000 characters)
above the bar. Hidden when the step cannot be edited (sent, cancelled, closed sequence); disabled with its reason when
`defaults.generation_available` is false (*… pas configurée sur ce serveur …*) or the message is scheduled
(*déprogrammez-le avant de le régénérer*). A confirmation (*Régénérer le message Contact ?*, *Retour* focused) comes
first when a saved text, unsaved edits or a validation would be lost; it says the result stays a Brouillon. While
the AI writes: *L’IA rédige le message Contact…* with a live seconds counter, the editor read-only, and a sentence
saying that nothing changes before it arrives and that switching tabs is safe (the answer lands in the cache whatever
editor is shown); the browser stops waiting after 5 min (the server bounds its own wait) and reloads the sequence. The
result replaces the shown text and is announced (*Brouillon Contact rédigé par l’IA : relisez-le…*, plus *repassé en
Brouillon* after a validation); an AI text carries *Rédigé par l’IA — à relire avant de valider.* with the model and
prompt version as a muted monospace hint. Every `ai_*` code has its French sentence saying that nothing was changed;
the message codes reuse `contact/messages.ts`.

**Unsaved text**: kept per step — switching tabs loses nothing, a dot marks a tab with unsaved changes; leaving the
prospect (list, previous/next, Back, another page) with unsaved mail or follow-up asks *Modifications non
enregistrées* (*Rester sur ce prospect* / *Quitter sans enregistrer*); reload or close triggers the browser prompt.

**Refresh**: a message write replaces the step in the cache and re-reads the list (message chips), the counters and
the prospect's history; a prospect write (`useProspectMutations`, every path) also refreshes Contact (`contactKeys`)
and Home.

## Reste à faire (later Slices)

- **S6 (Toolbox)**: add `contact_message_remote_draft_cleanups` (the reference's queue) and enqueue the old remote draft
  id wherever it is detached today — `contact_messages._clear_validation` (edit, reopen),
  `contact_message_cancellation.cancel_message` (manual cancel, decision 29, opposition) — then delete them after
  commit.
- **S7 (dispatch)**: inside the claim transaction, re-read the prospect state **and** `do_not_contact` and refuse to
  send on a closed sequence; send `r1`/`r2` only once the previous step is `sent`; after a definitive failure, cancel
  the message if the sequence closed meanwhile; reclaim stale claims after a TTL based on `dispatch_claimed_at`
  (a stale claim may have sent: reconcile, never resend blindly); report the in-flight messages the UI was told about.
