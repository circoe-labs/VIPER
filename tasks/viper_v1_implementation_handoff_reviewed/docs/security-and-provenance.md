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

## Retention/backup/deletion
Exact retention, anonymization, hosting and backup requirements remain product/ops/legal decisions. The implementation should centralize configuration and avoid destructive cascade defaults that make later compliance impossible.
