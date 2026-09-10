# Task 03 — Implement core relational schema and migrations

## Goal
Implement reviewed V1 logical data model including durable contactability, company domain, provenance/import support and lightweight contact tracking.

## Context
Use `../../docs/data-model.md`. This schema must remain simple enough for V1 yet safe for future agents.

## Coding Skill Requirement
Before editing code, load and follow `/caveman` and `/coding-guideline` from `~/ai/skills/`.

## Scope
### In Scope
- Companies, establishments, prospects, roles, categories, segments, referents.
- Emails/phones alias records.
- Contact tracking + status history.
- Contactability/do-not-contact state.
- Prospect provenance, import batches/row metadata, audit table.
- Stable IDs/FKs/indexes/uniqueness constraints.

### Out of Scope
- No rich opportunity/project CRM.
- No agent/campaign/message tables.
- No full RBAC.

## Dependencies
Tasks 01-02.

## Implementation Steps
1. Translate logical model to schema.
2. Create migrations/reset path.
3. Add indexes and invariants.
4. Seed only minimal configurable taxonomies.
5. Add repository/service interfaces.
6. Test company-change and contactability constraints at domain/service boundary.

## Files Likely Touched
DB schema/migrations, domain types, repositories, seed files, integration tests.

## Architecture Constraints
Taxonomies are data, not immutable enums. `do_not_contact` cannot be erased by new tracking/import. Internal referents are not auth users.

## Testing Requirements
Migration reset, FK/unique/index tests, one-primary email/phone rule, many categories, contactability persistence, response/appointment tracking fields.

## Acceptance Criteria
- Clean DB migrates.
- Data model matches reviewed docs.
- Permanent suppression is structurally separate from stage.
- No CRM overreach.

## Documentation Updates
Generate/update schema/ERD docs if supported.

## Handoff Notes
Company alias table is optional; add only if Task 08 dedup proves it materially useful.

## Implementation report

Date: 2026-09-10 · Branch `claude` · Backend only (frontend untouched).

### What was done
- **Schema** — SQLAlchemy 2 typed models for the full logical model (16 tables: `roles`, `commercial_segments`,
  `activity_categories`, `internal_referents`, `companies`, `company_activity_categories`, `establishments`,
  `prospects`, `emails`, `phones`, `contact_tracking`, `contact_tracking_status_history`, `prospect_sources`,
  `import_batches`, `import_row_metadata`, `audit_log`) and a hand-written, reviewed Alembic revision `0002`
  (upgrade + full downgrade, enum values frozen as literals, three plpgsql trigger functions).
- **Conventions** (ADR-0002) — UUIDv7 keys (+ `gen_random_uuid()` fallback), `timestamptz`, `updated_at` maintained by
  a trigger, fixed value sets as `varchar(32)` + CHECK, deterministic constraint names, explicit ON DELETE rules
  (RESTRICT for taxonomy/referent/company references, CASCADE for a prospect's own data, no FKs on `audit_log`),
  normalized storage (SIREN/SIRET digits, lowercase emails/domains, digit phone numbers).
- **Database invariants** — partial unique indexes (one primary email/phone per prospect, one primary establishment
  per company), primary ⇒ active, unique SIREN/SIRET when present, one current tracking row per prospect, per-prospect
  email/phone uniqueness, case-insensitive taxonomy labels + slug uniqueness, do-not-contact consistency CHECK,
  `has_name`, append-only `audit_log` (UPDATE/DELETE/TRUNCATE rejected), `guard_do_not_contact` trigger (no reset
  except through the dedicated operation, no deletion of a blocked prospect), FK and lookup indexes.
- **Domain services** — `app/services/prospects.py` (`mark_do_not_contact`, `clear_do_not_contact` with mandatory
  reason, `change_company`), `app/services/contact_tracking.py` (`save_contact_tracking` + status history with actor
  snapshot, never touches contactability); minimal repositories; `ActorContext`/`ActorType` in `app/core/actor.py`
  for Task 04 to populate.
- **Seeds** — `python -m app.seed [--db test]`: idempotent `INSERT … ON CONFLICT DO NOTHING` of suggested roles (4),
  commercial segments (3) and activity categories (4); never modifies existing rows; no companies/prospects/referents.
- **Docs** — `doc/adr/0002-data-schema-conventions.md`; `doc/architecture/data-model.md` physical section with Mermaid
  ERD, tables, value sets, deletion rules, service rules, seeds; decision log I-09…I-16; security/privacy, runbook and
  testing-strategy updates. CI migration smoke now also runs the seed twice.

### Files
- `backend/app/core/actor.py`; `backend/app/models/{common,enums,taxonomies,companies,prospects,contact_tracking,imports,audit,__init__}.py`
- `backend/app/repositories/{prospects,companies,taxonomies}.py`; `backend/app/services/{errors,prospects,contact_tracking}.py`; `backend/app/seed.py`
- `backend/migrations/versions/0002_core_schema.py`
- `backend/tests/{builders,test_migrations,test_schema_constraints,test_contactability,test_contact_tracking,test_company_change,test_seed}.py`
- `doc/adr/0002-data-schema-conventions.md`, `doc/architecture/{data-model,security-and-privacy}.md`,
  `doc/process/{runbook-local-dev,testing-strategy}.md`, `doc/product/decision-log.md`, `.github/workflows/ci.yml`

### Tests run
- `python scripts/verify.py` → privacy guard OK, ruff check/format OK, mypy strict OK (51 files), **pytest 70 passed**
  (20 before; +50), eslint/tsc OK, **vitest 8 passed**, vite build OK.
- `alembic -x db=dev|test upgrade head` → `downgrade base` → `upgrade head` → `current` = `0002 (head)` on both DBs;
  `alembic upgrade 0001:0002 --sql` (offline) renders.
- `python -m app.seed --db dev|test` twice each → 4/3/4 inserted, then 0/0/0.
- New coverage: migration round-trip leaves no tables/functions; ORM↔migration diff; CHECK names and enum value lists
  vs ORM; `set_updated_at` trigger on every timestamped table; every FK behind a full index; SIREN/SIRET duplicate
  rejected + NULL repeats allowed + format; two primary emails/phones/establishments rejected; inactive primary
  rejected; per-prospect address uniqueness but cross-prospect duplicates allowed; normalization CHECKs; many
  categories per company; RESTRICT on in-use taxonomy/referent/company/import batch; prospect-delete cascade;
  `do_not_contact` rejected as tracking status; DNC persistence, idempotency, direct ORM/raw-SQL reactivation
  rejected, deletion rejected, clear requires reason, guard re-arms after clear, tracking never changes
  contactability; tracking response/appointment/referent fields + ordered history with actor snapshot; company change
  clears employment verification and un-verifies active channels without deleting; audit append-only; seed
  idempotency and respect of user renames/label clashes.

### Deviations / decisions (decision log I-09…I-16)
- Names individually nullable with an "at least one name" CHECK; `company_id` nullable in DB (I-10).
- Civility codes `mr`/`ms` (I-11).
- Do-not-contact enforced by a DB trigger; blocked prospects cannot be deleted (I-12).
- Company change clears `employment_verified_at`; every active channel is treated as company-dependent (I-13).
- Email/phone unique per prospect only (I-14).
- `prospect_sources.collected_at` NOT NULL default now, `import_batch_id` FK, actor snapshot columns (I-15).
- Import batch status/count/fingerprint columns; `ActorContext` placeholder (I-16).

### Open points / known gaps
- No audit events are written yet (Task 05): services already take `ActorContext`; `clear_do_not_contact` validates
  its reason but it is only persisted once the audit event exists. Old/new company likewise.
- The DNC trigger is an accident guard, not a security boundary (the app role owns the tables).
- Retention/erasure of blocked prospects and of `audit_log` needs the open product/legal decision (open question #2).
- Not enforced: SIRET prefix = company SIREN (Task 07 validation); inactive referent assignment (Task 06/15 selectors).
- Substring search indexes (`pg_trgm`) deferred to Task 17; company alias table not added (see handoff note).
- `import_batches.status` values may be refined by Task 09 (CHECK migration).
- The CI change was not run on GitHub (nothing pushed); the Mermaid ERD was not rendered locally.

### Rework after orchestrator review — transaction boundaries (decision I-17)
- Services (`prospects`, `contact_tracking`) and the seed no longer commit: they flush; the caller owns the
  transaction. New `app.db.session.unit_of_work(session_factory)` (commit on success, rollback on exception);
  `SessionDep` now wraps each request in it with `Depends(scope="function")` so the commit happens before the
  response is sent; `python -m app.seed` uses it too.
- `write_cleared_contactability` resets the clearing flag in a `finally` while the transaction is usable; after a
  failed flush the aborted transaction/savepoint rollback discards it (a reset there would mask the error — verified
  by a mutation check).
- Tests: `session_factory` fixture (sessions share the per-test transaction; commits are savepoint releases); the API
  `client` fixture now runs the real per-request unit of work. New `test_transactions.py` (5 tests): unit of work
  commits; two service calls in one unit of work are atomic (second fails on an FK → first rolled back); a clear
  inside a larger transaction leaves the flag `off` and later generic resets rejected; the flag does not outlive a
  failed clear; request commits on success and rolls back on `HTTPException`.
- Docs: overview *Transaction boundaries*, agent-brief bullet, decision I-17, amendment note on ADR-0001, testing
  strategy. ADR-0002 does not mention commits (unchanged).
- `python scripts/verify.py` → all green; pytest **75 passed**, vitest 8 passed.
