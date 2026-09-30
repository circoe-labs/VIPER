# Contact — dashboard and mail sequence (backend contract)

Contact port, Slice S3 (handoff Tasks 09, 11, 12; decisions H-14 … H-29 of
`tasks/viper_contact_pipeline_handoff/docs/01-decision-log.md`). This page is the API contract the Contact page
(Slice S4) builds on. States of a prospect and the next-action week are described in
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
who are not `do_not_contact`. `failure`, `response_received`, `appointment_obtained` stay in scope (filterable).

**Counters** (read-only; each equals the `total` of `GET /api/contact/prospects?counter=<key>` under the same `q`):

| Key | Card | Definition |
|---|---|---|
| `to_handle` | À traiter cette semaine | union of the three below (disjoint by state) |
| `first_contact` | Premier contact | `neutral`, next action reached or overdue |
| `follow_up` | Relances | `contacted` (R1 to prepare) or `r1` (R2 to prepare), reached or overdue |
| `review` | Revues R2 | `r2`, reached or overdue — a human review/closing, not another mail (H-13) |
| `appointments` | RDV pris | current state `appointment_obtained`, cumulative, no time window (H-18) |

« Reached or overdue » = `planned_contact_at` before next week's Monday (business time, Europe/Paris), i.e. the
next-action ISO week ≤ the current ISO week. The four due counters also exclude prospects whose activity is
`inactive` (Prospection's `actionable()`). An overdue week never changes a state (H-10): it stays « à traiter » until a
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

Refusals: 422 `invalid` with `field: "week"`, `reason: "iso_week"` (malformed or non-existent week, e.g. `2025-W53`);
422 `invalid` with `field: "state"`, `reason: "not_filterable"` (`ignored`).

The left panel uses `GET /api/prospects/{id}` (editor view, with tracking and cadence suggestion) and changes the
state/week with `PATCH /api/prospects/{id}/tracking`. That answer now also carries `cancelled_messages` (integer, the
unsent messages a sequence-closing state cancelled; additive field).

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
- **Schedule** (H-25): from `validated` only, an explicit ISO 8601 moment **with offset**, strictly in the future; no
  default time, unrelated to the next-action week (H-14). **Unschedule** keeps the validation.
- **Sent** is immutable (H-21: service + database trigger). No route marks a message sent.
- **Cancel** (a person, or decision 29 below) keeps the content; **reopen** brings a cancelled step back to `draft`.
- **Optimistic concurrency**: every change of an existing message sends the `expected_revision` it read.
  `revision` changes with the content (and a reopening), never with validate/schedule/unschedule/cancel.
- **Human actor** only (403 `human_actor_required`).
- **Closed sequence**: prospect state `response_received`, `appointment_obtained` or `ignored`, or the opposition
  `do_not_contact` — create, edit, validate, schedule and reopen are refused; unschedule and cancel stay possible.
- **Decision 29**: when a person (or an import) sets `response_received`, `appointment_obtained` or `ignored`, every
  `draft`/`validated`/`scheduled` message of the prospect is cancelled in the same transaction
  (`cancel_reason = "prospect_state:<state>"`); `sent`/`cancelled` are untouched; a message claimed by the dispatcher
  (S7) is left to it. Setting `do_not_contact` from the editor does not cancel messages (they can no longer be
  validated or scheduled, and the dispatcher re-checks the opposition — S7).

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

`MessagesOut`:

```json
{
  "sequence": {"prospect_id": "…", "state": "contacted", "do_not_contact": false, "closed": false},
  "defaults": {"from_email": "prospection@exemple.example", "to": ["jean.test@exemple.example"]},
  "steps": [{"step": "contact", "message": null}, {"step": "r1", "message": null}, {"step": "r2", "message": null}]
}
```

`defaults.from_email` = `VIPER_DEFAULT_OUTBOUND_EMAIL` (null when unset), `defaults.to` = the primary e-mail.

`MessageContentIn` (unknown fields refused): `expected_revision` (omitted/null = create the step's message; else the
revision read), `from_email` (null clears it), `subject` (≤ 998), `body_text` (≤ 100 000), `to`, `cc`, `bcc` (lists of
≤ 50 addresses; blanks dropped, lowercased, deduplicated). An omitted field keeps its value — or, on creation, the
default (`from_email`, `to`) or empty.

`MessageResult`: `{"message": Message, "created": bool, "changed": bool, "unvalidated": bool}`.

`Message`: `id`, `prospect_id`, `step`, `status`, `from_email`, `to`, `cc`, `bcc`, `subject`, `body_text`,
`revision`, `validated_revision`, `validated_at`, `validated_by` (display name), `scheduled_at`, `sent_at`,
`cancelled_at`, `cancel_reason` (`manual` | `prospect_state:<state>`), `generation_model`,
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
| 422 | `invalid` | bad address (`field`: `from_email`, `to.1`, `cc.0`…; `reason` `format`/`too_many`), past moment (`field: scheduled_at`, `reason: not_future`) | `field`, `reason` |
| 403 | `human_actor_required` | non-human actor | |

## Audit and privacy

Each message change is one audit event on the message, in the prospect's history: `contact_message.created`,
`.updated` (edit of a draft), `.unvalidated` (edit that cleared a validation), `.validated`, `.scheduled`,
`.unscheduled`, `.cancelled` (context `reason`: `manual` or `prospect_state:<state>`), `.reopened`. The content
(`from_email`, recipients, subject, body) is **masked** in the audit log (`[masked]`: it changed, never what it says)
and never logged. Application logs carry ids, step, status, revision and actor type only. There is no separate
message journal: the append-only audit log already records who, when, which transition and which revision.

## Configuration

`VIPER_DEFAULT_OUTBOUND_EMAIL` (optional): the sender pre-filled in a new message; unset → typed by hand (a message
cannot be validated without one). Validated at startup (`x@y` form).
