# Security, Privacy and Provenance — V1

## Public repository constraint
`circoe-labs/VIPER` was public at review time. The real Excel workbook contains contact information. It is a private local reference only.

Implementation rules:
- do not commit the real workbook;
- add appropriate ignore rules before local fixture use;
- never print raw rows/emails/phones into CI logs or docs;
- commit only synthetic fixtures;
- avoid storing raw uploaded workbook bytes unless explicitly required; store import batch metadata/fingerprint instead.

## Authentication
The functional source requires a single securely authenticated commercial user for the pilot. Implement one-user authentication/session without building a permissions matrix. Internal referents are domain records, not login accounts.

## Provenance
Every contact/prospect should be able to retain source, date added and legal-basis/collection-context metadata even when initially unknown. Import origin should include workbook/sheet/row references without exposing them publicly.

## Audit
Meaningful mutations from human/import/Database Explorer must be auditable. Actor model must support future agent/system actors.

## Do-not-contact
Opposition is durable and distinct from non-interest. Import/merge/new contact tracking must not silently reactivate blocked prospects.

Implemented in the schema (Task 03, [ADR-0002](../adr/0002-data-schema-conventions.md)): `do_not_contact` is a prospect
contactability status, never a contact-tracking stage; a database trigger rejects any write that resets it except the
dedicated `clear_do_not_contact` operation (mandatory reason) and rejects deleting a blocked prospect.

## Database Explorer exposure
The explorer shows only allowlisted domain tables (`app/services/explorer/policy.py`); every other table — in
particular authentication users/sessions with password or token hashes — must be explicitly withheld, and objects
outside the ORM are unreachable. Columns can be hidden or masked centrally. Queries are validated against metadata
and bound as parameters; the read API has no write method; CSV exports neutralize spreadsheet formulas. Details:
[database-explorer.md](../features/database-explorer.md).

## Retention/backup/deletion
Exact retention, anonymization, hosting and backup requirements remain product/ops/legal decisions. The implementation should centralize configuration and avoid destructive cascade defaults that make later compliance impossible.

Current deletion rules (Task 03): taxonomy/referent/company references are RESTRICT (deactivate instead of delete);
deleting a prospect cascades to its own personal data (emails, phones, tracking, sources, import row metadata);
`audit_log` has no FKs and is append-only (UPDATE/DELETE/TRUNCATE rejected by triggers), so purging or redacting it
under a future retention policy requires an explicit, reviewed migration. Import batches store metadata and an
optional SHA-256 fingerprint, never workbook bytes.
