# Task 05 — Implement audit and provenance core before feature mutations

## Goal
Provide append-only mutation audit and prospect/contact provenance services used by import, forms and Database Explorer.

## Context
The first handoff put audit too late. All later mutation-heavy tasks must depend on this core.

## Coding Skill Requirement
Before editing code, load and follow `/caveman` and `/coding-guideline` from `~/ai/skills/`.

## Scope
### In Scope
- AuditService API and storage.
- Actor/source types: human, import, system, future agent.
- ProspectSource/ProvenanceService.
- Before/after change summaries with safe payload filtering.
- Import-batch provenance helpers.
- Service integration hooks/patterns.

### Out of Scope
- No full visible timeline UI yet.
- No rollback engine.
- No SIEM/event bus.

## Dependencies
Tasks 03-04.

## Implementation Steps
1. Define typed audit/provenance contracts.
2. Implement append-only writes.
3. Add safe serializer/filter for changes.
4. Add provenance create/query helpers.
5. Document required mutation integration pattern.
6. Add tests.

## Files Likely Touched
Audit/provenance services/repos/types/tests.

## Architecture Constraints
Never log secrets or unnecessary raw PII payloads. Audit actor comes from server ActorContext. Provenance and audit are separate concepts.

## Testing Requirements
Human mutation, import actor, source metadata, safe before/after, ordering, append-only behavior.

## Acceptance Criteria
- Later tasks can emit audit events through a stable service.
- Prospect source/date/legal-context can be stored.
- Actor attribution works.

## Documentation Updates
Document event/provenance schemas.

## Handoff Notes
Visible history appears in Task 19, but audit generation starts now.

## Implementation report

Date: 2026-09-10 — branch `claude`.

### What was done

- **AuditService** (`backend/app/services/audit.py`): typed contract — `AuditSource` (`ui`, `import`,
  `database_explorer`, `cli`, `agent`), `AuditContext` (source, request id, import batch id, `on_behalf_of`),
  a closed action vocabulary (generic `<entity>.created|updated|deleted` for the registered entities + a short
  `AuditAction` list), the registry `AUDITED_ENTITIES` (entity type + history subject per model).
  Integration pattern ([ADR-0006](../../../../doc/adr/0006-audit-integration.md)): services call
  `audit.annotate(session, actor, row, action?, reason=, labels=)` before changing a row; a single `after_flush`
  hook writes exactly one event per changed audited row in the same transaction (annotated action/actor, or the
  generic action with the actor bound to the session). `require_session` binds the signed-in user
  (`source=ui`, `request_id`) to every protected request; `audit_source(...)` lets a router (Database Explorer)
  switch the source. `record_event` covers non-row events (auth, bulk inserts). Exact "before" values via
  `active_history`. No double logging by construction.
- **Change capture** (`audit_changes.py`): JSON-safe serialization (UUID, datetime/date, Decimal, enums, sets,
  nested), `diff` for explicit dicts, attribute-history capture incl. many-to-many id lists.
- **Payload policy** (`app/core/audit_policy.py`): excluded entities (`user`, `user_session`), secret fields by name
  and fragment dropped at any depth, masked `legacy_metadata`, personal fields behind one switch
  `personal_values` = `full` (V1, I-27) / `masked` / `omitted`. No payload is logged.
- **Schema**: migration `0004` adds `audit_log.subject_type` / `subject_id` + index, so a prospect's history
  includes its emails, phones, tracking and sources.
- **Wired mutations**: `mark_do_not_contact` / `clear_do_not_contact` (reason persisted in `context.reason`, closes
  the I-12 gap — I-28), `change_company` (company ids + names as labels, employment verification, one
  `email/phone.updated` per re-verified channel), `save_contact_tracking` (`created` / `status_changed` /
  `updated`), auth `auth.login` (`open_session`), `auth.logout` (new `sign_out`), CLI `auth.user_created` /
  `auth.password_reset` (system actor; `create_or_reset_user` now takes the actor), taxonomy seed (`role.created`…
  by a system actor).
- **ProvenanceService** (`app/services/provenance.py`): `add_source`, `add_manual_source`, `add_import_source`,
  `list_sources`. **Import-batch helpers** (`app/services/import_batches.py`): `start_batch`, `importing` (import
  actor convention, I-29), `record_row`, `finish_batch`, `get_batch`.
- **Reads**: `audit.history(subject)`, `audit.recent_activity(...)` (newest first, `occurred_at` then `id`);
  `GET /api/audit/recent?limit=1..100` (protected by `api_router`).

### Files

New: `backend/app/core/audit_policy.py`, `backend/app/services/{audit,audit_changes,provenance,import_batches}.py`,
`backend/app/repositories/{audit,provenance}.py`, `backend/app/api/routes/audit.py`,
`backend/migrations/versions/0004_audit_subject.py`, `backend/tests/{test_audit,test_audit_payload,test_provenance}.py`,
`doc/adr/0006-audit-integration.md`, `doc/architecture/audit-and-provenance.md`.
Changed: `app/models/audit.py`, `app/api/{dependencies,router}.py`, `app/api/routes/auth.py`, `app/cli.py`,
`app/seed.py`, `app/repositories/taxonomies.py`, `app/services/{auth,prospects,contact_tracking}.py`,
`tests/builders.py` and the contactability / company-change / contact-tracking / auth / CLI / seed tests;
docs `security-and-privacy.md`, `data-model.md`, `overview.md`, `agent-brief.md`, `testing-strategy.md`,
`decision-log.md` (I-26 … I-30), ADR-0002 (amended header).

### Tests run

- `python scripts/verify.py --e2e` → privacy guard OK, ruff/format OK, mypy OK (77 files), **pytest 159 passed**
  (115 before), eslint/tsc OK, **vitest 207 passed**, build OK, **Playwright 12 passed**.
- New coverage: session-actor attribution with a forged payload actor, Database Explorer source, import actor and
  `on_behalf_of`, only-changed-fields and exact before values (incl. unloaded attributes), JSON types, secrets never
  stored (User change attempted three ways), masking switch, no payload in logs, ordering with id tie-break,
  append-only, failed mutation rolls back its events, no double logging, generic ORM updates captured, DNC set/clear
  with reason, company change, tracking status, auth trail, provenance create/query, import batch lifecycle incl.
  failure after rollback.

### Deviations / decisions

- I-26 integration pattern (annotations + single flush writer + binding in `require_session`, subject columns,
  closed vocabulary, seed/CLI audited); I-27 personal values stored in full behind one switch; I-28 clearing reason
  in the audit event; I-29 import actor convention and **no per-row audit event for `import_row_metadata`** (the task
  text asked each helper to emit an event; row metadata is a write-once trace and copying legacy values into the
  undeletable log was judged worse — batch and entity events cover the import); I-30 auth trail without
  IP/user-agent/token/session id, failed sign-ins not audited.
- `create_or_reset_user` signature gained the `actor` argument (only caller: the CLI).

### Open points / risks

- Core bulk statements, raw SQL and database-level cascades are not captured by the hook (documented; code using
  them must call `record_event`). Task 12 must write through the ORM and keep non-audited tables
  (`users`, `user_sessions`, `import_row_metadata`, status history, `audit_log`) read-only.
- ~~Writes in a session with neither binding nor annotation are not audited~~ — superseded by the rework below:
  such writes now fail.
- Personal values in audit are full until the retention decision (open question #2); redaction of existing events
  would need a reviewed migration targeting `subject_id`.

### Rework after orchestrator review (fail closed, decision I-31)

- The flush hook now **raises `UnattributedMutationError`** when an audited row changes with neither an annotation
  nor a bound actor; the flush fails and the transaction rolls back. Tables outside the audit are listed with their
  reason in `NOT_AUDITED_TABLES` (`users`, `user_sessions`, `import_row_metadata`,
  `contact_tracking_status_history`, `company_activity_categories`, `audit_log`); a test requires every ORM/database
  table to be audited or listed.
- Greppable binding for non-HTTP code: `audit.attributed_unit_of_work(session_factory, actor)`; `app/cli.py` and
  `app/seed.py` use it. `audit.bind`/`bound` take an optional context (defaults from the actor type).
- Tests: the `db_session` fixture binds `FIXTURE_ACTOR` (system actor for setup data); other test transactions use
  `attributed_unit_of_work(..., FIXTURE_ACTOR)`; the unauthenticated test route in `test_transactions.py` binds
  explicitly. `audit_events` leaves out fixture writes; a dedicated test shows they are attributed. New tests:
  unattributed write raises and rolls back (update and create), unaudited tables accept unattributed writes, bound
  system actor, annotation without binding, fixture attribution, table classification. DNC/API tests now bind the
  operator like a signed-in request.
- Docs: ADR-0006 (amended), `audit-and-provenance.md` ("bind an actor or your write fails"), decision log I-31,
  security and testing pages.
- `python scripts/verify.py --e2e` → all green: pytest **163 passed**, vitest 207 passed, Playwright 12 passed;
  ruff/format/mypy/eslint/tsc/build OK. `python -m app.seed --db test` smoke: seeded rows audited by
  `Suggestions VIPER` with `source=cli`.
