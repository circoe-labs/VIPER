# VIPER V1 — Implementation report (GPT)

## Scope delivered
The branch implements the manual, database-first VIPER V1 described by the reviewed handoff: authenticated human interface, normalized shared-data foundation, controlled Excel adapter, manual verification/contact tracking, Home, Prospection, Database, Settings, global search and an Exploitation placeholder.

## Source-of-truth guardrails
- No IProspect or IContact runtime behavior is mocked.
- No automatic email sending or Calendly synchronization exists.
- Durable `contactability_status=do_not_contact` cannot be cleared by the standard prospect update endpoint and import never rewrites it.
- Imported rows carry source provenance; opaque fields are retained in `import_row_metadata.legacy_metadata`.
- Real source workbook data is not committed and is explicitly ignored/blocked by CI.
- Normandie / transport-logistique targeting is not enforced as a database constraint.

## Verification against handoff
The implementation was checked against `tasks/TODO.md`, `docs/data-model.md`, `docs/interface-spec.md`, `docs/excel-mapping.md`, `docs/security-and-provenance.md`, `docs/04-testing-and-quality.md`, `docs/05-critical-review.md` and `grill-session.md`.

### Satisfied acceptance areas
Authentication, normalized IDs/FKs, prospect/company split, aliases, verification dates/statuses, opposition durability, audit/provenance, controlled Excel preview/commit, normalized export, human Prospection workspace, Home real-data metrics, read-only SQL enforcement, taxonomies/referents, global search and honest Exploitation placeholder.

### Known partial area
Task 12's full DBeaver-class generic staged mutation UX (column pin/reorder/resize, generic add/delete with rich FK diagnostics, context menu operations) is not fully implemented. Domain editors are the safe mutation path in this V1 branch; the status is intentionally `[~]` rather than falsely complete.

## Security notes
Single-user pilot auth uses opaque in-memory session tokens in HTTP-only SameSite=strict cookies. Production must provide strong credentials and HTTPS. No plaintext mailbox password is stored because mail integration is out of scope.

## Testing
Unit tests cover Excel anomaly handling and SQL mutation rejection. CI runs install, typecheck, tests, build and a private-workbook leakage check. Local static checks validate TypeScript syntax and the SQLite schema independently of dependency installation.
