# 02 — Architecture Spec

## Layers

### UI
Routes: Home, Prospection, Exploitation, Database, Settings. Global shell provides search, theme/contrast handling and authenticated user context.

### Application services
Use explicit service boundaries rather than UI-to-ORM coupling:
- ProspectService (domain rules in `app/services/prospects.py`; the Prospect editor's view model and atomic save in
  `app/services/prospect_editor.py`, Task 15 — [prospect-editor.md](../features/prospect-editor.md))
- CompanyService (Task 07: `app/services/companies.py` — [company-editor.md](../features/company-editor.md))
- ContactChannelService (Task 15: `app/services/contact_channels.py` — alias normalization and full-list save)
- ContactTrackingService
- ProspectQueryService (Task 14: `app/services/prospection/` — canonical segments + counters/list, read-only,
  [prospection-kpis.md](../features/prospection-kpis.md), [ADR-0014](../adr/0014-canonical-prospect-segments.md))
- TaxonomyService (Task 06: `app/services/taxonomies.py`; internal referents in `app/services/referents.py` — [settings-taxonomies.md](../features/settings-taxonomies.md))
- ImportPreviewService / ImportCommitService
- ExcelExportService
- DatabaseExplorerService
- AuditService
- ProvenanceService
- Auth/ActorContext

### Persistence
Relational transactional database, versioned migrations, stable IDs, FK constraints, indexes and explicit deletion rules. Technology: PostgreSQL 16 + SQLAlchemy 2 + Alembic ([ADR-0001](../adr/0001-stack.md)).

### Code layout (backend)
`app/api` (thin routers) → `app/services` (business rules; flush, never commit) → `app/repositories` (ORM/SQL
queries) → `app/models` / `app/db`. The frontend reaches data only through `/api/*` via `frontend/src/api/client.ts`.

Frontend server state lives only in TanStack Query: every list or search key contains its parameters, no page keeps
fetched data in its own state, and every write refreshes the caches it affects with
`refreshAfterWrite(queryClient, keys)` (`frontend/src/api/refresh.ts`; a lint rule forbids a bare `invalidateQueries`).
It cancels the requests in flight before invalidating, because TanStack Query keeps the first request of a new key
(a search typed just before a save) and would show its pre-save answer (decision I-150).

### Transaction boundaries
**Services flush, callers commit; one request = one transaction.**
- Services and repositories mutate the session and `flush()` when they need database-generated values or an early
  constraint check. They never call `commit()` or `rollback()`, so several service calls compose into one atomic
  operation (Prospect editor save, import commit, staged Database Explorer changes).
- The transaction is owned by the caller through the unit of work `app.db.session.unit_of_work(session_factory)`:
  it commits once when the block succeeds and rolls back if it raises.
- HTTP: routers receive `SessionDep` (`app/api/dependencies.py`), a request-scoped unit of work declared with
  `Depends(..., scope="function")` — committed after the route returns and **before** the response is sent (a failed
  commit fails the request), rolled back on any exception, `HTTPException` included.
- Non-HTTP callers (CLI such as `python -m app.seed`, future import jobs) wrap their whole operation in
  `unit_of_work` themselves.
- Transaction-local database state set by a service (e.g. the do-not-contact clearing flag) is reset before the
  service returns, so later statements of the same transaction stay guarded.

### Import/export adapters
Legacy file names/columns are adapter concerns. Domain services must not depend on Excel column names.
The import engine (Task 08, [ADR-0007](../adr/0007-import-engine.md)) is `app/services/imports/`: a pure
`build_preview(file, reference, mapping)` producing a typed `ImportPreview`; legacy headers live only in its
`fields.py`, and only `reference_loader.py` reads the database (SELECTs, to build the reference snapshot). Task 09
adds the pure review (`review.py`, `decisions.py`: groups, defaults, validated plan) and the commit service
`app/services/import_commit.py`, which writes through the domain services in one savepoint
([ADR-0012](../adr/0012-stateless-import-review.md)).
The export (Task 10, [ADR-0013](../adr/0013-normalized-excel-export.md)) mirrors it: `app/services/exports/spec.py`
is the only module knowing the exported sheets and columns, `projection.py` reads the domain (SELECTs through
`app/repositories/exports.py`) and `workbook.py` writes the XLSX; `app/services/excel_export.py` (ExcelExportService)
builds and audits the download.

### Auth + actor context
The pilot is single-user, but it must be securely authenticated. Application user identity is distinct from `internal_referents`. All mutations receive an actor context.

Implemented by Task 04 ([ADR-0004](../adr/0004-authentication-sessions.md)): server-side sessions (`users`,
`user_sessions`), `app/api/router.py` splits `public_router` (health, sign-in) from `api_router`, whose dependency
`require_session` protects **every** feature router included in it (session + CSRF on unsafe methods). Mutation
routes declare `actor: CurrentActor` and pass it to services; the frontend wraps the shell in `RequireAuth`.

### Provenance + audit
Provenance answers **where a prospect/contact datum came from**; audit answers **who changed what and when**. Keep them separate.

Implemented by Task 05 ([ADR-0006](../adr/0006-audit-integration.md), [audit-and-provenance.md](audit-and-provenance.md)):
services annotate the rows they change (`audit.annotate`), a flush hook writes one event per changed row in the same
transaction, and `require_session` binds the signed-in user to the request's session so even generic writes are
attributed server-side. Every new mutation follows the recipe in that page.

## Key boundaries

- Prospection UI ≠ raw Database Explorer.
- Internal referents ≠ login users.
- Permanent contact suppression ≠ current contact-tracking stage.
- Activity status (`Active/Inactive/Unknown`) ≠ verification date.
- Employment verification ≠ email/phone verification.
- Excel mapping ≠ relational schema.
- Activity categories/roles/segments are data-driven taxonomies, not rigid user-uneditable enums.
- Future agents use stable service/data contracts and actor/provenance fields; no agent UI/behavior in V1.

## Change-of-company rule

When a Prospect changes company:
1. audit old/new company;
2. set employment verification as needing a fresh check (clear or supersede the employment verification date according to implementation semantics);
3. mark professional emails/phones that are company-dependent as needing re-verification without deleting them;
4. surface a visible warning/action in Prospection (and, before the save, in the Prospect editor — Task 15);
5. preserve old values in audit/history, not as a public CV UI.

## Contact suppression rule

`Do not contact` is durable and prospect-level (or equivalent durable restriction record), independent of contact-tracking stage. New imports or future contact cycles cannot silently reactivate a blocked prospect.

## Database Explorer safety

Read path, staged edit path and SQL path are separate. The read path (Task 11) is `app/services/explorer/`: a
default-deny exposure policy, metadata from the ORM, a validated filter AST compiled to Core statements with bound
parameters, GET-only routes under `/api/explorer` ([ADR-0005](../adr/0005-database-explorer-grid.md),
[database-explorer.md](../features/database-explorer.md)). The staged edit path (Task 12,
[ADR-0008](../adr/0008-explorer-staged-writes.md)) is a separate router: one change set per table, validated against
the same metadata plus a default-deny editability policy, applied all or nothing through the ORM in the request's
transaction (audited as `database_explorer`), delegating to `ProspectService` / `ContactTrackingService` where they
own the rule, with optimistic row versions (`updated_at`) and server-side delete diagnostics. Opposition columns stay
read-only (the do-not-contact trigger backs it). The SQL path (Task 13,
[ADR-0011](../adr/0011-read-only-sql-console.md)) runs one read statement per request as a dedicated read-only
database role whose privileges are derived from the same exposure policy; the database, not a parser, refuses
writes and hidden tables.
