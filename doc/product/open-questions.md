# Open Questions / Deferred Decisions

These do not justify blocking the whole V1. Resolve at the earliest task that truly needs the decision and record it.
State at the end of V1 (Task 20, 2026-09-11) in *italics*.

1. ~~**Stack**~~ — *resolved by I-01 / ADR-0001 (FastAPI + SQLAlchemy + PostgreSQL, React + TypeScript + Vite).*
2. **Hosting/backups/retention** — source requires secure hosting/backups and a retention/anonymization policy, but
   exact values are not decided. *Still open. `doc/process/runbook-production.md` lists what any host must provide
   (PostgreSQL ≥ 16 with `unaccent`/`pg_trgm`, one process behind TLS, secrets, provisioning after migrations) and the
   decisions left to the product owner and operator: provider, backups (frequency, retention, encryption, restore
   tests), retention/anonymization durations — including whether audit events keep full contact values (I-27,
   one switch) — and log retention.*
3. **Legacy week year** — `S37/S39` has no year; flag/request context, never invent. *Handled without inventing:
   the import review asks for a year per batch or per week (I-55, I-74); without one the planned date stays empty
   and the raw code is kept in the row's legacy metadata. The real file has two such week codes: the operator chooses
   their year at import.*
4. **Legacy Mode de contact** — raw values are `Auto`, `Commercial`, `Commerciale`; preserve until meaning is
   confirmed. *Still open: preserved verbatim as legacy metadata (`opaque_field`), exported in `Données d'origine`.*
5. **Second `A contacter`** — currently `Oui/OUI` on a few rows; preserve as legacy metadata until semantics are
   known. *Still open: preserved verbatim, like #4.*
6. **Exact export order** — *narrowed by Task 10*: a V1 default order following the grill's priorities is shipped
   (decision I-84, `doc/features/excel-import-export.md`) and can be changed in one module
   (`app/services/exports/spec.py`, no migration). Open only if the operator wants another order.
7. ~~**Alias export shape**~~ — *resolved by Task 10* (decision I-86): primary e-mail/phone in the main sheet, every
   alias (with primary/active/verification/origin) in the `E-mails` / `Téléphones` sheets keyed by `ID VIPER`.
8. **Multiple independent contact cycles** — default V1: one current contact tracking + status history. *Unchanged:
   V1 ships one tracking per prospect with its full status history; a second cycle would be a later data-model
   change.*
9. **Stale threshold** — UI can show never verified immediately; do not hardcode “stale after N months” until product
   chooses N. *Task 14:* `VIPER_VERIFICATION_STALE_DAYS` (unset by default) turns it on in « À revérifier » once
   chosen (I-91). *Still open for product: only the value is missing.*
10. **Light-theme pixel polish** — derive conservatively from Neon Command; dark theme is authored reference.
    *Task 20 reviewed every main page in both themes at 1440×900 and 1280×800: consistent, contrast-tested (token test
    and axe), no overflow. Pixel polish beyond that remains a product/design choice.*
11. **Company aliases/merge history** — optional technical enhancement if import dedup needs persistent alias names; do
    not add unless it materially simplifies real duplicate handling. *Not added: on the real file the review groups
    the company spellings into 253 company keys (variants flagged) and the default commit creates 247 companies (rows
    without any name excluded); an acknowledged re-import links every row to an existing company. No need for
    persistent aliases was observed.*
12. **Logo neon vs UI accent** (I-21) — the delivered logo artwork uses a lime neon (~`#79FA03`), the UI accent is
    Viper Green `#00E676`. *Open brand question; the app uses the artwork as delivered.*
13. **Rows known by one name part only** (I-157) — a person with one name part is matched with the same company;
    a row with one name part, no company and no e-mail has nothing to match on, so a re-import creates it again (one
    such row in the real file). *Open for the operator: complete these rows (a name or a company) after the first
    import, or exclude them at re-import.*
