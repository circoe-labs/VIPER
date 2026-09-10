# VIPER V1 — Implementation report

This branch implements the reviewed database-first V1 handoff. It deliberately excludes IProspect, IContact, automatic email sending, Calendly sync and rich CRM behavior.

## Architecture
React/Vite client → authenticated Express API → service/database layer → SQLite. Audit/provenance and durable do-not-contact semantics are first-class.

## Privacy
The real BASE_CLIENT workbook is never committed. `.gitignore` and CI reject it and the `sources/` tree. Import uses in-memory uploads and stores metadata rather than raw workbooks.

## Open deployment decisions
Hosting, backup, retention/anonymization duration, production identity provider, exact export ordering and future agent/mail/Calendly contracts remain open as specified by the handoff.
