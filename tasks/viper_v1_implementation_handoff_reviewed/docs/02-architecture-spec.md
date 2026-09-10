# 02 — Architecture Spec

## Layers

### UI
Routes: Home, Prospection, Exploitation, Database, Settings. Global shell provides search, theme/contrast handling and authenticated user context.

### Application services
Use explicit service boundaries rather than UI-to-ORM coupling:
- ProspectService
- CompanyService
- ContactChannelService
- ContactTrackingService
- TaxonomyService
- ImportPreviewService / ImportCommitService
- ExcelExportService
- DatabaseExplorerService
- AuditService
- ProvenanceService
- Auth/ActorContext

### Persistence
Relational transactional database, versioned migrations, stable IDs, FK constraints, indexes and explicit deletion rules. Exact technology is selected in Task 01.

### Import/export adapters
Legacy file names/columns are adapter concerns. Domain services must not depend on Excel column names.

### Auth + actor context
The pilot is single-user, but it must be securely authenticated. Application user identity is distinct from `internal_referents`. All mutations receive an actor context.

### Provenance + audit
Provenance answers **where a prospect/contact datum came from**; audit answers **who changed what and when**. Keep them separate.

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
4. surface a visible warning/action in Prospection;
5. preserve old values in audit/history, not as a public CV UI.

## Contact suppression rule

`Do not contact` is durable and prospect-level (or equivalent durable restriction record), independent of contact-tracking stage. New imports or future contact cycles cannot silently reactivate a blocked prospect.

## Database Explorer safety

Read path, staged edit path and SQL path are separate. SQL is SELECT/read-only in V1 and backend-enforced. Grid writes use validated services/transactions, generate audit events, and respect referential integrity/contact-suppression rules.
