# Audit and provenance

Two separate concepts (overview, *Provenance + audit*):

- **Provenance** — *where a prospect's data came from*: `prospect_sources` rows (origin, date obtained, legal basis or
  collection context, who recorded it), plus the import trace (`import_batches`, `import_row_metadata`).
- **Audit** — *who changed what, and when*: the append-only `audit_log`.

Design and rationale: [ADR-0006](../adr/0006-audit-integration.md). Decisions: I-26 … I-30 in the decision log.
Code: `backend/app/services/audit.py` (service, vocabulary, flush hook), `audit_changes.py` (change capture),
`app/core/audit_policy.py` (payload policy), `app/services/provenance.py`, `app/services/import_batches.py`.

## Audit event (`audit_log`)

| Column | Content |
|---|---|
| `id` | UUIDv7 (time-ordered; tie-break of equal timestamps) |
| `occurred_at` | `clock_timestamp()` at insert: distinct and ordered within one transaction |
| `actor_type`, `actor_id`, `actor_display` | Snapshot of the server-side `ActorContext` (see *Actors*) |
| `entity_type`, `entity_id` | The row that changed (`email` + its id) |
| `subject_type`, `subject_id` | The record whose history shows the event (the email's `prospect`); equal to the entity for root records |
| `action` | Dot-namespaced verb from the vocabulary below |
| `changes` | Changed fields only (see *Change sets*), after the payload policy |
| `context` | `source`, and when relevant `request_id`, `import_batch_id`, `on_behalf_of`, `reason` |

The table has no foreign keys (events outlive rows) and database triggers reject `UPDATE`, `DELETE` and `TRUNCATE`
(ADR-0002). Indexes: `occurred_at`, `(entity_type, entity_id, occurred_at)`, `(subject_type, subject_id,
occurred_at)`.

### Change sets

`{"field": {"before": <value>, "after": <value>}}` with only the fields whose value changed:

- **updated** rows: previous and new value of each changed column (exact even if the old value was not loaded);
- **created** rows: every non-null column as `after` (database defaults included), `before` null — plus loaded,
  non-empty many-to-many collections (a company created with its categories, Task 07);
- **deleted** rows: every non-null column as `before`, `after` null;
- many-to-many collections as sorted id lists under `<relationship>_ids` (e.g. `activity_categories_ids`);
- `id`, `created_at`, `updated_at` are never included;
- reference fields may carry readable snapshots, e.g. `company_id: {before, after, before_label, after_label}`;
- values are JSON-safe: UUID and `Decimal` → string, `datetime`/`date` → ISO 8601 (with offset), enums → value,
  sets → sorted lists. Unknown types are refused (never stringified silently).

### Context

| Key | When | Meaning |
|---|---|---|
| `source` | always | `ui` (signed-in request), `import`, `database_explorer`, `cli`, `agent` |
| `request_id` | HTTP requests | UUIDv7 shared by every event of one request (one save) |
| `import_batch_id` | import writes | The batch being imported |
| `on_behalf_of` | import (future agents) | `{type, id, display}` of the human who confirmed the automated work |
| `reason` | when given | Free-text justification, e.g. why a do-not-contact restriction was lifted. Never masked: write reasons without unnecessary personal detail |

When the session has no binding (an annotated write outside a request) or a binding was made without a context, the
source defaults from the actor type: human → `ui`, import → `import`, system → `cli`, agent → `agent`.

### Actors

| Type | `actor_id` | `actor_display` | Where it comes from |
|---|---|---|---|
| `human` | `users.id` | the user's display name | the session (`require_session` / `CurrentActor`), never the payload |
| `import` | the import batch id | `Import <filename>` | `import_batches.importing(session, batch, confirmed_by=<human>)` |
| `system` | `app.cli`, `app.seed` | `Ligne de commande`, `Suggestions VIPER` | CLI commands |
| `agent` | agent identifier | agent label | future IProspect/IContact (not in V1) |

## Action vocabulary

Small on purpose (Task 19: "no infinite event taxonomy"); the service rejects anything else.

**Generic lifecycle** — `<entity>.created`, `<entity>.updated`, `<entity>.deleted` for every audited entity:

| Entity type | Table | Subject |
|---|---|---|
| `company` | `companies` (incl. `activity_categories_ids`) | itself |
| `establishment` | `establishments` | its `company` |
| `prospect` | `prospects` | itself |
| `email`, `phone` | `emails`, `phones` | their `prospect` |
| `contact_tracking` | `contact_tracking` | its `prospect` |
| `prospect_source` | `prospect_sources` | its `prospect` |
| `role`, `commercial_segment`, `activity_category`, `internal_referent` | taxonomy/referent tables | itself |
| `import_batch` | `import_batches` | itself |

Not audited as rows — `NOT_AUDITED_TABLES`, each with its reason: `users`, `user_sessions` (secrets — auth events
instead), `import_row_metadata` (write-once import trace; legacy values must not be copied into an undeletable log),
`contact_tracking_status_history` (derived history of an audited change), `company_activity_categories` (recorded on
the company as `activity_categories_ids`) and `audit_log`. A test requires every table to be audited or listed there.
The Database Explorer (Task 12) keeps the unaudited tables read-only; the one exception, `company_activity_categories`,
is written through `Company.activity_categories` and so recorded as `company.updated` (`writes.LINK_TABLES`, enforced by
`tests/test_explorer_editability.py`). Explorer writes carry `context.source = database_explorer`.

**Fail closed** (I-31): a flush that changes a row of an audited table with neither an annotation nor a bound actor
raises `UnattributedMutationError` and the transaction rolls back.

**Semantic actions** (`AuditAction`):

| Action | Emitted by | Notes |
|---|---|---|
| `prospect.company_changed` | `prospects.change_company` | `company_id` with both company names as labels, `employment_verified_at` cleared; each re-verified channel gets its own `email.updated` / `phone.updated` |
| `prospect.do_not_contact.set` | `prospects.mark_do_not_contact` | status, date, reason; `context.reason` |
| `prospect.do_not_contact.cleared` | `prospects.clear_do_not_contact` | the mandatory clearing reason is kept **only** here, in `context.reason` (I-28) |
| `contact_tracking.status_changed` | `contact_tracking.save_contact_tracking` | stage change (+ any date changed in the same save); `.created` for a new row, `.updated` for date/referent-only changes |
| `import_batch.started` / `.committed` / `.failed` / `.cancelled` | `import_batches.start_batch` / `finish_batch` | file name, sheets, fingerprint, status, counts |
| `auth.login` / `auth.logout` | `auth.open_session` / `auth.sign_out` | who and when only — no token, session id, IP or user agent; failed sign-ins are not audited (I-30) |
| `auth.user_created` / `auth.password_reset` | `auth.create_or_reset_user` (CLI) | no field values |
| `export.generated` | `GET /api/exports/workbook` (Task 10) | entity `excel_export` (no id); `<sheet>_rows` per sheet and `size_bytes` — never a value (ADR-0013) |
| `explorer.sql_executed` | `POST /api/explorer/sql` (Task 13) | entity `sql_query`; `query_sha256`, `query_length`, `outcome`, and `row_count` / `truncated` / `duration_ms` when it ran — never the query text (I-67) |
| `<taxonomy>.renamed` / `.deactivated` / `.reactivated` (`role`, `commercial_segment`, `activity_category`) and `internal_referent.deactivated` / `.reactivated` | `taxonomies.rename_value` / `set_value_active`, `referents.set_referent_active` (Task 06, `SettingsChange`) | label or `active` before/after; creation, referent edits and deletion use the generic lifecycle actions |

## Payload policy (`app/core/audit_policy.py`)

Applied to every event when it is stored:

1. **Excluded entities** `user`, `user_session`: no field values at all.
2. **Secret fields** dropped at any depth: `password_hash`, `token_hash`, `csrf_token`, and any field whose name
   contains `password`, `token`, `secret` or `csrf`.
3. **Masked fields** (value replaced by `[masked]`, the change stays visible): `legacy_metadata`.
4. **Personal fields** — prospect `first_name`/`last_name`, email `address`, phone `number`, and `source_reference`
   of emails/phones/sources — follow one switch, `POLICY.personal_values`:
   `full` (V1 default, decision I-27) · `masked` (`j•••@example.com`, `•••42`, `E•••`) · `omitted` (`[personal]`).
   Tightening applies to new events only; existing ones need an explicit redaction migration.

Audit payloads are never written to application logs (tested).

## How a mutation integrates — the recipe

**Bind an actor or your write fails**: every change to an audited table needs an actor, from an annotation or from
the session binding; otherwise the flush raises `UnattributedMutationError`.

1. **Route**: include the router in `api_router`, declare `actor: CurrentActor` and pass it to the service. The
   request's session is already bound to the signed-in user (`source=ui`, `request_id`). A Database Explorer router
   adds `dependencies=[Depends(audit_source(AuditSource.DATABASE_EXPLORER))]`.
2. **Service**: before creating, changing or deleting each audited row, call
   `audit.annotate(session, actor, row)` — with a semantic `AuditAction` when one applies, `reason=` when the user
   gave one, `labels=` for readable reference changes — then mutate, then `session.flush()`. Never build diffs or
   insert `AuditLogEntry` rows yourself. Annotate only when you are about to change the row.
3. **Bulk Core statements / raw SQL** are invisible to the flush hook: prefer the ORM; otherwise call
   `audit.record_event(...)` for each affected row (see `app/seed.py`).
4. **Outside HTTP** (CLI, seed, jobs, future agents): open the transaction with
   `audit.attributed_unit_of_work(session_factory, actor)` instead of `unit_of_work` — e.g.
   `ActorContext(type=ActorType.SYSTEM, display="…", id="app.<command>")` as in `app/cli.py` and `app/seed.py`
   (`audit.bound(session, actor)` narrows it to a block). **Imports** use
   `import_batches.importing(session, batch, confirmed_by=human)` and pass the yielded import actor to services.
5. **New table**: add the model to `AUDITED_ENTITIES` (entity type + subject) or to `NOT_AUDITED_TABLES` with the
   reason (the classification test fails otherwise); add personal/secret/masked fields to the policy.
6. **New semantic action**: add it to `AuditAction` and to the table above — sparingly; prefer the generic action.
7. **Tests**: assert the event (action, actor, changes, context) with `tests.builders.audit_events`, which leaves
   out setup writes. `db_session` is bound to `FIXTURE_ACTOR`; call `bind_operator(session)` to act as a signed-in
   user; a signed-in `client` request is bound automatically; other test transactions use
   `attributed_unit_of_work(session_factory, FIXTURE_ACTOR)`.

## Reads

- `audit.history(session, subject_type, subject_id, limit=50)` — a prospect's/company's timeline, child rows
  included, newest first (`occurred_at`, then `id`, descending).
- `audit.recent_activity(session, limit=50, subject_types=None, actor_types=None)` — global feed. Home (Task 16)
  reads the human events on `prospect` / `company` subjects and turns them into structured lines without field values
  (`app/services/home.py`, `recent_edits`; wording in `frontend/src/home/activity.ts`).
- `GET /api/audit/recent?limit=1..100` — raw events for the signed-in user (no UI yet; Task 19 formats them and keeps
  raw JSON out of normal screens).

## Provenance

`app/services/provenance.py`:

- `add_source(session, actor, prospect_id, source_type, *, source_reference, collected_at, legal_basis_or_collection_context, notes, import_batch_id)`
  — `source_type` `excel_import | manual | future_agent | other`; an `excel_import` source requires its batch and
  only it may have one; `collected_at` (timezone-aware) defaults to the database transaction time; the actor snapshot
  is stored on the row.
- `add_manual_source(...)` — typical hand-entered prospect: `manual`, collected now.
- `add_import_source(session, actor, prospect_id, batch, *, sheet, row_number, legal_basis_or_collection_context)`
  — `excel_import` with the batch and a readable `"<file> / <sheet> / ligne <n>"` reference; collected at import
  time (the original collection date of legacy rows is unknown, I-15).
- `list_sources(session, prospect_id)` — oldest first.

Creating a source is itself audited (`prospect_source.created`), like any row.

### Import batches (`app/services/import_batches.py`, for Task 09)

```
start_batch(human)  ─► pending ── importing(batch, confirmed_by=human) ─► entity writes by the import actor
                                                                          + add_import_source + record_row
                       └─► finish_batch(human, committed | failed | cancelled, counts)
```

- `start_batch(session, actor, *, filename, sheet_names, file_fingerprint)` — `pending`; the batch row keeps the
  human who started it; `import_batch.started`.
- `importing(session, batch, confirmed_by)` — binds `ActorContext(IMPORT, <batch id>, "Import <filename>")` with
  `source=import`, `import_batch_id`, `on_behalf_of` (and the request id), yields the import actor.
- `record_row(session, batch, *, sheet, row_number, legacy_metadata, prospect_id, company_id)` — write-once
  `import_row_metadata` with JSON-safe legacy values; no audit event per row (I-29).
- `finish_batch(session, actor, batch, status, *, rows_total, rows_imported, rows_skipped)` — only from `pending`;
  sets `committed_at` for `committed`.
- `list_batches`, `committed_with_fingerprint`, `batch_counts` — history, re-import warning, detail counts.

The Excel import commit (Task 09, `app/services/import_commit.py`, ADR-0012) follows this cycle inside one savepoint:
`start_batch` (with the batch's legal basis and source reference) by the user → `importing(...)` → companies,
prospects, tracking, `add_import_source` + `record_row` per imported row → `finish_batch(committed)`. Settings values
the user chose to create are created before `importing`, so their events are by the user (`source=ui`). On failure the
savepoint rolls back and `start_batch` + `finish_batch(failed)` are recorded in the same request transaction.

## Known limits

- Writes that bypass the ORM unit of work (Core bulk statements, raw SQL, `ON DELETE CASCADE`) are not captured
  automatically (see recipe step 3).
- Retention and erasure of audit events are undecided (open question #2): erasing a prospect keeps its events;
  redaction by `subject_id` needs an explicit, reviewed migration or maintenance role.
