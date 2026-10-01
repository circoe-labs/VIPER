# Contact — dashboard, mail sequence and the Contact page

Contact port, Slice S3 (handoff Tasks 09, 11, 12; decisions H-14 … H-29 of
`tasks/viper_contact_pipeline_handoff/docs/01-decision-log.md`) for the API, Slice S4 (Tasks 08, 10, 13) for the page
([§ Contact page](#contact-page-ui-slice-s4)), Slice S5 (Task 14) for the AI drafting
([§ AI drafting](#ai-drafting-s5--post-apiprospectsprospect_idmessagesstepgenerate)). The **sequences rework**
(Slice S1 of `tasks/viper_import_excel_sequences/`, decisions D1-D12, [decision log R-01 … R-11](../product/decision-log.md#sequences-rework-decisions-import-excel-and-contact-sequences-2026-10-01))
replaced the next-action week and the states `contacted`/`r1`/`r2`/`failure` by cohorts, sequences and real sends:
[§ Cohorts, sequences and alerts](#cohorts-sequences-and-alerts-sequences-rework). Its Slice S3 opened the messages to every rank up to
« max relances » and replaced the dashboard by the weekly planning ([§ Weekly planning](#weekly-planning--get-apicontactdashboard)). The commercial state is chosen with
`PATCH /api/prospects/{id}/tracking` ([`prospect-editor.md`](prospect-editor.md)); segments are in
[`prospection-kpis.md`](prospection-kpis.md); the tables in
[`../architecture/data-model.md`](../architecture/data-model.md#cohorts-and-contact_sequences).

Every endpoint below requires a session; `PUT`/`POST` also the CSRF header (`X-CSRF-Token`). Refusals use the
shared shape `{"detail": {"code": "...", "message": "...", ...}}`; a malformed request (unknown field, wrong type,
missing `expected_revision`, naive `scheduled_at`, unknown step/counter) is FastAPI's 422 `{"detail": [...]}`.

## Cohorts, sequences and alerts (sequences rework)

- **Cohort** `Sxx`: a prospecting session with the **real date** of its first send, entered by a person (never an ISO
  week: S39 may start on 28 September, ISO week 40). `S0` = validated but out of campaign (no date, never contacted,
  not Défaillant). The prospect's cohort is the cohort of its **current sequence**: `Sxx` = validated and in the
  pipeline, `S0` = validated out of campaign, none = not validated.
- **Sequence**: one prospect's run in one cohort. Changing the cohort (a person, `PUT /api/prospects/{id}/cohort`)
  closes the current sequence (`cohort_changed`, or `cohort_removed` with `cohort_id: null`), cancels its unsent
  messages (`cancel_reason = "sequence_closed"`) and opens a new one: the counter restarts at zero, the history (closed
  sequences, their messages) stays. Choosing the cohort of the open sequence changes nothing (`changed: false`).
  **Resuming** ([R-11](../product/decision-log.md#sequences-rework-decisions-import-excel-and-contact-sequences-2026-10-01)):
  putting the prospect in a cohort (S0 included) brings a state `disqualified`, `response_received` or
  `appointment_obtained` back to `neutral` (« En séquence »), with an appended history row and the audit event
  `contact_tracking.status_changed` (reason « Changement de cohorte : reprise en séquence »); the answer says which
  (`resumed_from`). Removing the cohort keeps the state. An `ignored` prospect (409 `ignored_is_terminal`) or one
  under the do-not-contact opposition (409 `prospect_do_not_contact`: clear it first with `PUT …/contactability`) is
  never resumed by a cohort change: the change is refused.
- **Level** = the number of messages **really sent** in the current sequence (`status = sent`, whatever their source):
  0 → *Contact* to send, n → *Rn* to send, more than « max relances » (`/api/settings/contact`, default 4) →
  « Relance terminée » (still contactable, out of the automatic actions). A drafted or scheduled message moves
  nothing. A current sequence closed `completed` (the former `failure`) is « Relance terminée » too.
- **Next due date**: the cohort's date for the Contact, then the **Monday of the calendar week after the last send**
  (business midnight, Europe/Paris). Nothing is due (`pause_reason`) without cohort (`no_cohort`), in S0
  (`out_of_campaign`), when the state is not `neutral` (`state`: response, RDV, ignored, Défaillant), under the
  do-not-contact opposition (`do_not_contact`: no mail may be prepared for the prospect), when the sequence
  is closed (`sequence_closed`) or finished (`finished`), or while an « Erreur sur le mail » raised by a person or an
  import is open (`email_error`).
- **« Marquer comme envoyé »** (`POST …/messages/mark-sent`): see [§ Mail sequence](#mail-sequence--apiprospectsprospect_idmessages).
- **Commercial state** (`PATCH …/tracking`): `neutral` (« En séquence »), `response_received`, `appointment_obtained`,
  `ignored`, `disqualified` (« Défaillant », a person only). Closing states cancel the unsent messages.
- **Quality alerts** (`email_error` « Erreur sur le mail », `function_to_check`, `data_inconsistent`,
  `company_to_check`, `import_conflict`): on a prospect or a company, source from the signed-in actor (`human`;
  `import`; `ai` for an agent — a proposal, without effect on the due date), resolved by a person. An alert never
  changes a state, a cohort or a sequence.
- **From the Excel import** (Slice S2, [R-12 … R-20](../product/decision-log.md#sequences-rework-decisions-import-excel-and-contact-sequences-2026-10-01),
  details in [`excel-import-export.md`](excel-import-export.md#import-redesign--cohorts-sequences-and-human-precedence-slice-s2)):
  a row's `Sxx` puts a prospect **without any cohort history** in that cohort (a sequence opened by the import
  actor); when the cohort's date is past, its Contact is recorded as sent that day at business midnight
  (`sent_source = import`, rank 0) — S0 records nothing. A prospect's cohort, sequence or state set before is never
  changed by an import: a different `Sxx` raises an `import_conflict` alert. « Défaillant » comes from an import only
  when the person validating it declared the file « vérifié humainement », for new prospects without a valid `Sxx`,
  and is attributed to **that person**. A value of the cohort column that is not a cohort (`retraité`) raises a
  `data_inconsistent` alert.

| Method | Path | Body | Answer |
|---|---|---|---|
| GET | `/api/settings/cohorts` | — | `[Cohort]` (S0 first, then by date): `id`, `code`, `starts_on`, `out_of_campaign`, `needs_review`, `current_count`, `sequence_count` |
| POST | `/api/settings/cohorts` | `{"code": "S39", "starts_on": "2026-09-28"}` | 201 `Cohort` |
| PATCH | `/api/settings/cohorts/{id}` | `{"code"?: "S40", "starts_on"?: "…"}` | `Cohort` (`needs_review` cleared) |
| DELETE | `/api/settings/cohorts/{id}` | — | 204 (409 `in_use` once a sequence used it, 409 `cohort_s0_fixed`) |
| GET / PUT | `/api/settings/contact` | `{"max_follow_ups": 4}` (0-20) | `{"max_follow_ups": 4}` |
| GET | `/api/prospects/{id}/sequences` | — | `{"prospect_id", "place": Place, "sequences": [Sequence]}` (current first, then newest) |
| PUT | `/api/prospects/{id}/cohort` | `{"cohort_id": "…" \| null}` | `{"place": Place, "changed", "resumed_from", "cancelled_messages", "in_flight_messages"}` |
| GET | `/api/alerts` | query `prospect`, `company`, `type`, `state` (`open` default, `resolved`, `all`), `limit`, `offset` | `{"items": [Alert], "total", "limit", "offset"}` |
| POST | `/api/alerts` | `{"type", "prospect_id" \| "company_id", "note"?, "detail"?}` | 201 `Alert` |
| POST | `/api/alerts/{id}/resolve` | `{"note"?}` | `Alert` |

`Place` = `cohort` (`{id, code, starts_on, out_of_campaign, needs_review}` or null), `sequence_id`, `sequence_open`,
`sent_count`, `level_label` (« Contact », « R2 », « Relance terminée » — the step to send, not the label of `level`),
`level` (the weekly planning's level key, `contact_pending`, `contact_sent`, `r<n>_sent`, `finished`; null without
cohort — the same key as the Contact and Prospection lists, whose `level_label` is that key's label, « R1 envoyée »),
`next_step` (`contact`, `r1`…; null when finished or without cohort), `finished`, `next_due_at`, `next_due_on`, `next_due_week`, `pause_reason`, `email_error`,
`max_follow_ups`. The editor view `GET /api/prospects/{id}` carries the same facts as `contact`. `Sequence` = `id`,
`cohort`, `is_current`, `opened_at`, `closed_at`, `end_reason`, `sent_count`, `messages` (`message_id`, `rank`, `step`,
`step_label`, `status`, `sent_at`, `sent_source`, `has_content`). `Alert` = `id`, `prospect_id`, `company_id`, `type`,
`source`, `note`, `detail`, `raised_by_type`, `raised_by`, `raised_at`, `open`, `resolved_at`, `resolved_by`,
`resolution_note`.

Refusals: 403 `human_actor_required` (a cohort, a cohort change, « max relances », Défaillant, resolving an alert:
a person only; a system job raises no alert); 404 `not_found`; 409 `duplicate` (cohort code, with `existing`), `in_use`,
`cohort_s0_fixed`, `alert_exists` (with `alert_id`), `alert_resolved`, `ignored_is_terminal` /
`prospect_do_not_contact` (cohort change); 422 `invalid` (`code` reason `cohort_code`,
`starts_on` reason `required` / `s0_without_date`, `max_follow_ups` reason `out_of_range`, alert `type` reason
`subject_type`, `prospect_id` reason `subject`).

## Weekly planning — `GET /api/contact/dashboard`

Sequences rework Slice S3 (handoff §11, [R-21 … R-26](../product/decision-log.md#sequences-rework-decisions-import-excel-and-contact-sequences-2026-10-01)).
Service `app/services/contact_dashboard.py`, read-only: no count, list or filter ever changes a state, a cohort, a
sequence or a message.

Query: `week` (`YYYY-Www`, default the current business week), `cohort` (a cohort id, or `none`: no cohort), `q`
(≤ 200 chars, the Prospection search: every word in names/company or an e-mail, or a phone number).

```json
{
  "today": "2026-10-01",
  "current_week": "2026-W40",
  "week": {"week": "2026-W40", "monday": "2026-09-28", "sunday": "2026-10-04", "is_current": true},
  "max_follow_ups": 4,
  "to_send": {
    "total": 4, "overdue": 1,
    "groups": [
      {"rank": 0, "step": "contact", "step_label": "Contact", "count": 2, "overdue": 0},
      {"rank": 1, "step": "r1", "step_label": "R1", "count": 0, "overdue": 0},
      {"rank": 2, "step": "r2", "step_label": "R2", "count": 1, "overdue": 1},
      {"rank": 3, "step": "r3", "step_label": "R3", "count": 1, "overdue": 0},
      {"rank": 4, "step": "r4", "step_label": "R4", "count": 0, "overdue": 0}
    ]
  },
  "levels": [
    {"level": "contact_pending", "label": "Contact à envoyer", "count": 5},
    {"level": "contact_sent", "label": "Contact envoyé", "count": 1},
    {"level": "r1_sent", "label": "R1 envoyée", "count": 1},
    {"level": "r2_sent", "label": "R2 envoyée", "count": 1},
    {"level": "r3_sent", "label": "R3 envoyée", "count": 1},
    {"level": "finished", "label": "Relance terminée", "count": 1}
  ],
  "categories": [
    {"category": "in_sequence", "label": "En séquence", "count": 10},
    {"category": "email_error", "label": "Erreur sur le mail", "count": 1},
    {"category": "finished", "label": "Relance terminée", "count": 1},
    {"category": "disqualified", "label": "Défaillant", "count": 1},
    {"category": "out_of_campaign", "label": "S0 (validé hors campagne)", "count": 1},
    {"category": "response_received", "label": "Réponse reçue", "count": 1},
    {"category": "appointment_obtained", "label": "RDV obtenu", "count": 1},
    {"category": "ignored", "label": "Ignoré", "count": 2}
  ],
  "cohorts": [{
    "id": "…", "code": "S37", "starts_on": "2026-09-07", "out_of_campaign": false, "needs_review": false,
    "prospects": 5, "in_sequence": 4, "to_send": 2, "overdue": 1,
    "levels": [{"level": "contact_pending", "label": "Contact à envoyer", "count": 0}, "…"]
  }],
  "weeks": [{"week": "2026-W39", "year": 2026, "number": 39, "monday": "2026-09-21", "count": 1}]
}
```

**Week.** An ISO calendar week, Monday 00:00 to Sunday 24:00 **business time** (Europe/Paris, daylight saving time
included: the week of 26 October 2026 starts at 23:00 UTC on Sunday 25). `current_week` is the week of the business
day. A cohort code `Sxx` is never a week (D5): weeks only place the derived next due dates.

**To send** (`to_send`). A prospect has something to send in the week when its derived next due date (the cohort's
date for the Contact, then the Monday after the last real send, [§ Cohorts](#cohorts-sequences-and-alerts-sequences-rework))
falls in it — **for the current week, every earlier due date too**: a step not sent stays to send, flagged `overdue`
(due before the current week's Monday), and never changes a state or a level. A future week shows only what falls in
it (what is planned), a past week what fell in it and is still unsent. One group per rank, from the Contact
(« nouveaux contacts à envoyer ») to R<max>, by the rank to send next. The predicate is the same as Prospection's
`due` and Home's (`segments.to_send_before`): an **actionable** prospect (contactable, not `inactive`) with a next due
date — so never without a cohort, in S0, in a state other than `neutral` (response, RDV, ignored, Défaillant), after
« Relance terminée », under the do-not-contact opposition or while an « Erreur sur le mail » raised by a person or an
import is open (the AI's alert is a proposal and pauses nothing). A drafted, validated, scheduled or cancelled
message moves nothing: only a real send does. A week without prospecting (no S38 between S37 and S39) changes
nothing either: the S37 sequences simply keep their next step due (overdue) until it is sent.

**Levels** (`levels`): the sequences **in progress** (`in_sequence`: a current sequence in a campaign cohort — not
S0 —, state `neutral`, no opposition; « Relance terminée » and a paused « Erreur sur le mail » included) by level,
derived from the real sends: `contact_pending` (nothing sent), `contact_sent`, `r<n>_sent` for n below the maximum,
`finished` (R<max> sent, or the sequence closed `completed`). Keys from `app/core/contact_steps.py` (`level_keys`),
the SQL twin is `contact_sequences.level_key_sql` (a test checks they agree). Lowering « max relances » moves the
sequences already past it to `finished` at once; raising it reopens them (nothing is stored).

**Categories** (a prospect may be in several): `in_sequence` (above), `email_error` (an open « Erreur sur le mail »
raised by a person or an import: cohort, state and history kept), `finished` (« Relance terminée »: in sequence and
finished — still contactable), `disqualified` (« Défaillant »), `out_of_campaign` (current cohort S0),
`response_received`, `appointment_obtained` (the state), `ignored` (the state `ignored` **or** the do-not-contact
opposition).

**Cohorts** (`cohorts`): each cohort holding current prospects under the filters, oldest date first, S0 last:
`prospects` (current cohort), `in_sequence`, `to_send` / `overdue` (in the week), and its sequences in progress by
level (`levels`, every key with its count; empty for S0) — a person sees e.g. S37 at « R3 envoyée ».

**Weeks** (`weeks`): the ISO weeks holding actionable next due dates (overdue ones included), oldest first — the
week selector's options.

**Scope and cost.** Prospects with a current sequence, a contact tracking or an open effective « Erreur sur le mail »,
under `cohort` and `q`. One derived row per prospect (subquery) then three aggregates (totals, per cohort, weeks):
four statements whatever the base, ≈ 0.6-0.9 s on 20 000 prospects in every planner state
(`tests/test_prospection_performance.py`). No index was added: these are whole-base reads planned with hash joins
(`whole_base_plan`, ADR-0019); the page's messages use the existing `UNIQUE(sequence_id, rank)` index.

Refusals: 422 `invalid` with `field: "week"`, `reason: "iso_week"` (malformed or non-existent week, e.g. `2025-W53`,
or a year outside 2000-2100); FastAPI's 422 for a malformed `cohort`.

## Lists — `GET /api/contact/prospects`

Query (combined with AND): `category` (`to_send` by default, `in_sequence`, `email_error`, `finished`,
`disqualified`, `out_of_campaign`, `response_received`, `appointment_obtained`, `ignored`), `week` (the planning week
of `to_send` and of the rows' `to_send`/`overdue` flags, default the current one), `rank` (the rank to send next,
0 … max), `level` (a level key), `cohort` (id or `none`), `q`, `sort` (`due` — next due date, soonest first, none
last —, `name`, `cohort` — cohort date, S0 and none last), `limit` (1-200, default 50), `offset` (≥ 0). Every count
of the dashboard is the `total` of the list with the same criteria: a rank group = `?rank=<n>` (and `week`), a level =
`?category=in_sequence&level=<key>`, a category = `?category=<key>`, a cohort = `?cohort=<id>` (with any of them).
Ties are broken by last name, first name, id.

```json
{
  "items": [{
    "id": "…", "civility": "ms", "first_name": "…", "last_name": "…", "exact_job_title": "…",
    "role_label": "…", "company_id": "…", "company_name": "…", "primary_email": "…",
    "activity_status": "active", "contactability_status": "contactable", "tracking_status": "neutral",
    "cohort_id": "…", "cohort_code": "S37", "cohort_starts_on": "2026-09-07", "out_of_campaign": false,
    "sent_count": 2, "last_sent_at": "2026-09-14T08:00:00Z",
    "level": "r1_sent", "level_label": "R1 envoyée", "finished": false,
    "next_rank": 2, "next_step": "r2", "next_step_label": "R2",
    "next_due_at": "2026-09-20T22:00:00Z", "next_due_week": "2026-W39",
    "to_send": true, "overdue": true, "email_error": false,
    "next_message_status": "draft",
    "messages": [{"rank": 0, "step": "contact", "status": "sent"}, {"rank": 1, "step": "r1", "status": "sent"},
                 {"rank": 2, "step": "r2", "status": "draft"}]
  }],
  "total": 1, "limit": 50, "offset": 0, "week": "2026-W40"
}
```

`messages` = every message of the **current** sequence by rank (a closed sequence's are in
`GET /api/prospects/{id}/sequences`); `next_message_status` = the one at `next_rank` (null: nothing prepared). Three
statements per page whatever its size.

Refusals: 422 `invalid` — `week` (`iso_week`), `rank` (`out_of_range`: above « max relances »), `level`
(`unknown_level`: not a key under the current maximum, e.g. `r4_sent` with max 4, which is `finished`); FastAPI's 422
for an unknown `category` or `sort`, a negative `rank`, a malformed `cohort`. The former `counter` and `state`
parameters are gone (ignored if sent).

The prospect sheet uses `GET /api/prospects/{id}` (editor view, with the tracking and the derived `contact` progress)
and changes the state with `PATCH /api/prospects/{id}/tracking`.

**Effect on the messages** (additive fields, S3): `PATCH /api/prospects/{id}/tracking`, the editor save
`PUT /api/prospects/{id}` and the opposition `PUT /api/prospects/{id}/contactability` answer the editor view plus
`cancelled_messages` (unsent messages cancelled by this save) and `in_flight_messages` (messages claimed by the
dispatcher, left to it — they may still leave). Both are 0 when nothing closed the sequence; `POST /api/prospects`
answers the plain view.

## Mail sequence — `/api/prospects/{prospect_id}/messages`

One durable message per **sequence and rank** (rework D6; H-20); the routes address the ranks of the prospect's
**current open sequence** by step code `contact` (0) | `r1` (1) | `r2` (2) | … | `r<max>`, up to « max relances »
(`/api/settings/contact`, 4 by default; sequences rework S3, [R-21](../product/decision-log.md#sequences-rework-decisions-import-excel-and-contact-sequences-2026-10-01)).
Codes and labels (« Contact », « R1 »…) come from `app/core/contact_steps.py`, shared by every API. A rank beyond the
maximum is refused for anything that prepares a mail — create, edit, validate, schedule, reopen, AI drafting: 409
`rank_beyond_max` (with `max_follow_ups`); a message kept there after the maximum was lowered stays readable,
unschedulable and cancellable. A malformed code (`r0`, `R1`, `r100`) is FastAPI's 422. No step ordering is enforced (R1 can be prepared before the Contact mail is sent). Message statuses: `draft` (Brouillon),
`validated` (Validé), `scheduled` (Programmé), `sent` (Envoyé), `cancelled` (Annulé) — distinct from the prospect's
state. A `sent` message is a real send and counts for the level.

### State machine

```
(none) --PUT--> draft --validate--> validated --schedule--> scheduled --(dispatcher, S7)--> sent (immutable)
(none)|draft|validated|scheduled|cancelled --mark-sent (a person)--> sent (source manual)
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
- **Sent** is immutable (H-21: service + database trigger). **« Marquer comme envoyé »**
  (`POST …/messages/mark-sent`, body `{"rank"?: 2, "sent_at"?: "<ISO 8601 with offset>"}`): a person declares that the
  **next step** of the open sequence (its first rank not sent yet) was really sent at `sent_at` (default now; 422
  `invalid` `sent_at` reason `in_future`, `before_previous_send`, `time_zone`). The step's unsent message — draft,
  validated, scheduled or cancelled — becomes that send (200, its text kept, a claimed one refused with
  `dispatch_in_progress`); without one a send record without text is created (201). Both are the same send: status
  `sent`, `sent_source = manual`, audit `contact_message.sent`, the level moves by one. The dispatcher (S7) will
  record `worker`, the import (S2) `import`, migration `0010` wrote `migration`. Only a dispatcher send needs the human
  validation (SQL CHECK). **Idempotency** ([R-22](../product/decision-log.md#sequences-rework-decisions-import-excel-and-contact-sequences-2026-10-01)): with `rank` (the step the person saw as next — the UI
  should always send it), a replay on a rank already sent answers that send (200, `created: false`,
  `changed: false`, no audit, nothing moves); another unsent rank than the next is refused (409 `rank_not_next`, with
  `next_rank` and `next_step`). Without `rank` every call records the next step. Concurrent declarations serialize on
  the sequence row. After R<max> the sequence is « Relance terminée » (nothing due), but a further send may still be
  declared (the prospect stays contactable).
- **Cancel** (a person, or decision 29 below) keeps the content; **reopen** brings a cancelled step back to `draft`.
- **Optimistic concurrency**: every change of an existing message sends the `expected_revision` it read.
  `revision` changes with the content (and a reopening), never with validate/schedule/unschedule/cancel.
- **Human actor** only (403 `human_actor_required`).
- **Closed sequence**: no open current sequence (no cohort, or a completed one: `no_open_sequence`), the cohort S0
  (`out_of_campaign`), prospect state `response_received`, `appointment_obtained`, `ignored` or `disqualified`
  (`prospect_sequence_closed`), or the opposition `do_not_contact` — create, edit, validate, schedule, reopen and mark
  sent are refused; unschedule and cancel stay possible. « Relance terminée » closes nothing (still contactable).
- **Decision 29 and the opposition**: when a person (or an import) sets `response_received`, `appointment_obtained`,
  `ignored` or `disqualified`, every `draft`/`validated`/`scheduled` message of the prospect is cancelled in the same transaction
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
| POST | `…/messages/mark-sent` | `{"rank"?: 0, "sent_at"?: "2026-09-28T10:00:00+02:00"}` | 201 (send record created) / 200 `MessageResult` (`changed: false` on a replay) |
| POST | `…/messages/{step}/generate` | `{"expected_revision"?: 1, "instruction"?: "…", "replace"?: true}` | 201 (created) / 200 `GenerationResult` — see *AI drafting (S5)* |

`MessagesOut`:

```json
{
  "sequence": {"prospect_id": "…", "state": "neutral", "do_not_contact": false, "sequence_id": "…", "out_of_campaign": false, "closed": false,
               "max_follow_ups": 4, "sent_count": 1, "next_rank": 1, "next_step": "r1", "finished": false,
               "level_label": "R1", "level": "contact_sent"},
  "defaults": {"from_email": "prospection@exemple.example", "to": ["jean.test@exemple.example"], "generation_available": true},
  "steps": [{"rank": 0, "step": "contact", "label": "Contact", "message": {"…": "…"}},
            {"rank": 1, "step": "r1", "label": "R1", "message": null}, "… up to r4"]
}
```

`steps` = every rank from the Contact to R<max>, in order, plus a message kept beyond a lowered maximum. `sequence`
carries the level of the current sequence (as `GET …/sequences` `place`): `sent_count`, `next_rank` / `next_step`
(null when finished or without cohort), `finished`, `level_label` (« Contact », « R2 », « Relance terminée » — the step
to send), `level` (the planning's key, e.g. `contact_sent`).

`defaults.from_email` = `VIPER_DEFAULT_OUTBOUND_EMAIL` (null when unset), `defaults.to` = the primary e-mail,
`defaults.generation_available` = the AI drafting is configured (`VIPER_OPENAI_API_KEY` and `VIPER_OPENAI_MODEL`).

`MessageContentIn` (unknown fields refused): `expected_revision` (omitted/null = create the step's message; else the
revision read), `from_email` (null clears it), `subject` (≤ 998), `body_text` (≤ 100 000), `to`, `cc`, `bcc` (lists of
≤ 50 addresses; blanks dropped, lowercased, deduplicated — also across lists: an address is kept in the first of
`to` > `cc` > `bcc`). Control characters (CR, LF, NUL…) are refused in `subject` and the addresses (header
injection); the body is free text. An omitted field keeps its value — or, on creation, the default (`from_email`,
`to`) or empty. An identical save answers `changed: false`, even on a closed sequence.

`MessageResult`: `{"message": Message, "created": bool, "changed": bool, "unvalidated": bool}`.

`Message`: `id`, `prospect_id`, `sequence_id`, `rank`, `step` (`contact`, `r3`…), `step_label` (« R3 »), `status`, `sent_source`, `from_email`, `to`, `cc`, `bcc`, `subject`, `body_text`,
`revision`, `validated_revision`, `validated_at`, `validated_by` (display name), `scheduled_at`, `sent_at`,
`cancelled_at`, `cancel_reason` (`manual` | `prospect_state:<state>` | `do_not_contact` | `sequence_closed`), `generation_model`,
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
| 409 | `prospect_sequence_closed` | write after `response_received` / `appointment_obtained` / `ignored` / `disqualified` | |
| 409 | `no_open_sequence` | write without an open current sequence (no cohort, or completed) | |
| 409 | `out_of_campaign` | write while the prospect is in S0 | |
| 409 | `rank_beyond_max` | create, edit, validate, schedule, reopen or AI-draft a rank above « max relances » | `max_follow_ups` |
| 409 | `rank_not_next` | `mark-sent` with an unsent `rank` that is not the next one | `next_rank`, `next_step` |
| 422 | `message_incomplete` | validate without from/to/subject/body | `fields`: `from_email`, `to`, `subject`, `body_text` |
| 422 | `invalid` | bad address (`field`: `from_email`, `to.1`, `cc.0`…; `reason` `format`/`too_many`/`control_character`), control character in `subject` (`reason: control_character`), send moment in the past (`field: scheduled_at`, `reason: not_future`) or more than a year ahead (`reason: too_far`) | `field`, `reason` |
| 403 | `human_actor_required` | not a person, or a person without an id | |

## AI drafting (S5) — `POST …/messages/{step}/generate`

The AI only **writes the subject and the body** (H-22, H-26): the result is always a `draft` that a person reviews,
edits and validates; nothing is validated, scheduled or sent, and the prospect's state, cohort, sequence and level
never change. Any rank up to R<max> (sequences rework S3, [R-23](../product/decision-log.md#sequences-rework-decisions-import-excel-and-contact-sequences-2026-10-01)): the purpose sentence follows the rank — R1
« première relance », a middle follow-up « relance Rn, courte… », R<max> « dernière relance (Rn), très courte, qui
clôt poliment la séquence » — and the earlier recorded messages of every lower rank of the current sequence are given
(cancelled or empty ones left out). Above the maximum: 409 `rank_beyond_max` before any AI call. Port of the
reference `src/server/contactMailGenerationService.ts`, `openaiMailGenerator.ts`, `mailGenerationPrompt.ts`.

| Module | Role |
|---|---|
| `app/services/mail_generation/prompt.py` | the versioned prompt (`PROMPT_VERSION = "contact-mail-fr-2026-10-v2"`: the reference's text, with the purpose by rank of S3), pure |
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
or activity context); for a follow-up Rn the recorded messages of the lower ranks (subject, body, status label;
cancelled or empty ones left out); on a regeneration the step's current subject and body; the « consigne »; `store: false`; and
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
| `VIPER_OPENAI_TIMEOUT_MS` | `60000` | Per network operation (each read / write; connect ≤ 10 s), 1 000–300 000. |
| `VIPER_OPENAI_MAX_RETRIES` | `2` | Retries on transient failures, 0–5. |
| `VIPER_OPENAI_TRUST_ENV` | `false` | `true`: the OpenAI calls honour the server's `HTTPS_PROXY`, `NO_PROXY`, `SSL_CERT_FILE`… (a corporate proxy or CA). Off: a direct connection the environment cannot redirect. |
| `VIPER_CONTACT_BOOKING_URL` | unset | Booking link the AI may copy into a mail; an `http(s)` URL (anything else is refused at startup). Unset: no link at all. |

## Concurrency note

The prospect state is read without a lock by a message write. A state change committed meanwhile waits for the
message row lock and then cancels that message too; the only gap is a **creation** racing the change: the new draft
is invisible to the cancellation and remains — it cannot be validated, scheduled or edited afterwards (closed
sequence), only read or cancelled.

## Contact page (UI, Slice S4)

`/contact` (`frontend/src/contact/`), in the navigation as *Contact* (Mail icon); `/exploitation` redirects to it.
Visual pattern: `doc/design/design-system.md` § *Contact page*. API module: `frontend/src/api/contact.ts`.

> **Outdated until Slice S5 of the sequences rework.** This section describes the page built in the Contact port.
> Since S3 the API answers the weekly planning above (`to_send`, `levels`, `categories`, `cohorts`; lists by
> `category`/`rank`/`level`) — the former `counts`/`counter`/`state` and the `contact`/`r1`/`r2`-only `messages` map
> are gone, so the page's counters and list do not work until S5 rebuilds them.

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
  send on a closed sequence; send a rank only once the previous one is `sent` (and only up to R<max>); after a definitive failure, cancel
  the message if the sequence closed meanwhile; reclaim stale claims after a TTL based on `dispatch_claimed_at`
  (a stale claim may have sent: reconcile, never resend blindly); report the in-flight messages the UI was told about.
- **S7 (dispatch), sequences rework**: mark the sends `sent_source = worker` (the only source that needs the human
  validation); never dispatch for a prospect whose open « Erreur sur le mail » (`email_error`, source human/import)
  pauses the sequence, nor in S0 or after « Relance terminée » without a person's action.
- **Sequences rework S4-S5** (S2, the import, and S3, the messages by rank and the weekly planning, are done —
  above): the UI — cohort, level, « Marquer comme envoyé » (send `rank`), alerts, « À vérifier », Paramètres (S4); the
  weekly planning page and the mail sequence with variable ranks (S5). Until S4 the page and the prospect editor still
  show the former states and the week planner: a former state answers 422, a week is ignored by the editor save and
  refused by `PATCH …/tracking` (422 `derived`).
