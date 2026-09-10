# ADR-0006 — Audit integration: service annotations, one flush-time writer, server-bound actor

- Status: accepted
- Date: 2026-09-10
- Deciders: Task 05 (audit and provenance core), for orchestrator review
- Related: `doc/architecture/audit-and-provenance.md` (schema, vocabulary, recipe),
  `doc/product/decision-log.md` (I-26 … I-30), ADR-0002 (append-only `audit_log`, actor snapshot),
  ADR-0004 (`require_session`, `CurrentActor`), migration `backend/migrations/versions/0004_audit_subject.py`
- Number: 0005 is reserved by the Database Explorer branch (Task 11).
- Amended: 2026-09-10 by the orchestrator review of Task 05 (decision I-31) — the hook **fails closed**: an audited
  row changed without an actor raises instead of going unaudited.

## Context

Every meaningful mutation must be audited — from forms (Tasks 06, 07, 15), the Excel import (Task 09) and the
Database Explorer's generic row edits (Task 12) — with the actor taken from the server, never the request. Events
must be readable later (Task 19: "email changed from X to Y", "company changed from A to B"), atomic with the change,
free of secrets, and must not be written twice for one change. Several later tasks are written by different agents:
the mechanism has to be hard to forget and easy to follow.

Options considered for *where* events are produced:

1. **Explicit calls only** — every service writes its events. Precise, but each service hand-builds diffs, and a
   forgotten call (or a generic explorer edit) leaves no trace.
2. **Flush listener only** — the ORM reports every changed row. Nothing is forgotten, but events have no meaning
   beyond `updated` (no reason for a do-not-contact clearing, no company names) and need an actor from somewhere.
3. **Both, side by side** — services write semantic events and a listener writes generic ones; each service must
   then tell the listener what it already covered, or every change is logged twice.

## Decision

**Services annotate; one flush-time hook writes.** A combination of 1 and 2 with a single writer:

- `audit.annotate(session, actor, row, action=None, *, reason=None, labels=None)` — called by a service *before* the
  flush that writes the change — says who changes this row and what the change means (a semantic action from
  `AuditAction`, or the generic lifecycle action when `action` is omitted).
- An `after_flush` session event (`app/services/audit.py`) writes **exactly one event per changed audited row** in
  the same transaction, from SQLAlchemy attribute history (updates) or the row state (creations, deletions): the
  annotated action and actor when there is an annotation, else `<entity>.created|updated|deleted` with the actor
  **bound to the session**. Double logging is impossible by construction: there is one writer and one event per row
  per flush. Annotating a row that still has unflushed changes flushes them first, so earlier generic edits keep
  their own event instead of being absorbed by the semantic one.
- **Binding**: `require_session` — the router-level dependency of every protected route — binds
  `ActorContext(HUMAN, users.id, display_name)` and `AuditContext(source=ui, request_id=<uuid7>)` to the request's
  session (`session.info`). Any audited write in a signed-in request is therefore attributed to the server-side user,
  even a generic write that no service annotated. Routers override the source with
  `Depends(audit_source(AuditSource.DATABASE_EXPLORER))`. Imports bind the import actor with
  `import_batches.importing(...)`; CLI, seed, jobs and future agents open
  `audit.attributed_unit_of_work(session_factory, actor)` (greppable; `audit.bound(...)` for a narrower block).
- **Fail closed** (I-31): when a flush changes a row of an audited table and that row has neither an annotation nor
  a bound actor, the hook raises `UnattributedMutationError`; the flush fails and the transaction rolls back. A
  forgotten binding in a new CLI command, job, agent or generic write is a loud error in its first test, never a
  silent audit gap. Tables deliberately outside the audit are listed with their reason in `NOT_AUDITED_TABLES`; a
  test requires every table to be either audited or listed there.
- **Exact "before" values**: every column of an audited model gets a no-op `set` listener with
  `active_history=True`, so SQLAlchemy loads the previous value when an unloaded attribute is replaced.
- **Non-row events** (sign-in/out, account creation, bulk Core inserts such as the seed) use
  `audit.record_event(...)`, which flushes pending changes first to keep the order.
- **Subject columns** (`subject_type`, `subject_id`, migration 0004): `entity_*` is the changed row (an email),
  `subject_*` the record whose history shows it (the email's prospect). Task 19 reads a prospect's timeline — its
  emails, phones, tracking and sources included, even deleted ones — with one indexed query.
- **Registry**: `AUDITED_ENTITIES` lists the audited ORM models with their entity type and subject;
  `NOT_AUDITED_TABLES` lists the others (login accounts/sessions, `import_row_metadata`, status history, the
  company-category link table recorded on the company, `audit_log`) with the reason for each.
- **Vocabulary**: actions are validated — the generic lifecycle actions of registered entities plus the short
  `AuditAction` list. Adding one is a reviewed code change.
- **Payload policy** centralised in `app/core/audit_policy.py` and applied to every event at storage time (secrets
  dropped, masked fields, personal-value switch; decision I-27).

## Consequences

- A new mutation service needs one line per changed row (`audit.annotate(...)`) and no diff code; forgetting it in
  a signed-in request still yields a generic event with the right actor. Database Explorer writes (Task 12) are
  audited as long as they go through the ORM, even without annotations.
- Code that writes audited rows outside a request must attribute them, or it fails. Test setup follows the same
  rule: the `db_session` fixture binds a `FIXTURE_ACTOR`, other test units of work use `attributed_unit_of_work`.
- Events are atomic with the change: a rolled-back transaction leaves no event (tested).
- **Core/bulk statements and raw SQL are invisible to the hook** (`session.execute(update(...))`, `insert(...)`):
  code using them must call `record_event` for the affected rows. Database-level `ON DELETE CASCADE` deletions are
  not individually audited (deleting a prospect records `prospect.deleted`; its emails vanish with it).
- A flush that writes an annotated row consumes its annotation; annotations left unused are discarded at the end of
  the transaction. Services must annotate only when they are about to change the row.
- One flush = one event per row: a composite save that flushes several times produces several events for the same
  row, correlated by `context.request_id`.
- The hook costs one multi-row INSERT per flush that touches audited rows, and an occasional SELECT when an
  unloaded attribute is replaced.

## Alternatives considered

- **Explicit calls only / listener only / both side by side** — see *Context*: forgettable, meaningless, or
  double-logging with bookkeeping.
- **PostgreSQL triggers writing `audit_log`** — would also catch raw SQL, but the actor and the meaning of the
  change live in the application (a transaction-local setting could carry the actor, but not labels, reasons or
  the personal-value policy), and JSON diffs in plpgsql are harder to review and test. Can be added later as a
  complement if raw writes appear.
- **`before_flush` capture** — ids and foreign keys of new rows (set through relationships) are not populated yet;
  `after_flush` still has the attribute history and has them.
- **Entity = aggregate root only (no subject columns)** — child rows (an edited email) would lose their own
  identity, which the explorer's per-row history needs; querying a JSON context key instead of indexed columns
  was rejected for the main Task 19 query.
- **Actor bound in `CurrentActor` instead of `require_session`** — a route mutating data without declaring
  `CurrentActor` would then escape attribution.
