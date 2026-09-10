# Open Questions / Deferred Decisions

These do not justify blocking the whole V1. Resolve at the earliest task that truly needs the decision and record it.

1. **Stack** — choose from repo/organization conventions; otherwise a boring typed web stack + relational DB.
2. **Hosting/backups/retention** — source requires secure hosting/backups and a retention/anonymization policy, but exact values are not decided.
3. **Legacy week year** — `S37/S39` has no year; flag/request context, never invent.
4. **Legacy Mode de contact** — raw values are `Auto`, `Commercial`, `Commerciale`; preserve until meaning is confirmed.
5. **Second `A contacter`** — currently `Oui/OUI` on a few rows; preserve as legacy metadata until semantics are known.
6. **Exact export order** — *narrowed by Task 10*: a V1 default order following the grill's priorities is shipped (decision I-84, `doc/features/excel-import-export.md`) and can be changed in one module (`app/services/exports/spec.py`, no migration). Open only if the operator wants another order.
7. ~~**Alias export shape**~~ — *resolved by Task 10* (decision I-86): primary e-mail/phone in the main sheet, every alias (with primary/active/verification/origin) in the `E-mails` / `Téléphones` sheets keyed by `ID VIPER`.
8. **Multiple independent contact cycles** — default V1: one current contact tracking + status history.
9. **Stale threshold** — UI can show never verified immediately; do not hardcode “stale after N months” until product chooses N. *Task 14:* `VIPER_VERIFICATION_STALE_DAYS` (unset by default) turns it on in « À revérifier » once chosen (I-91).
10. **Light-theme pixel polish** — derive conservatively from Neon Command; dark theme is authored reference.
11. **Company aliases/merge history** — optional technical enhancement if import dedup needs persistent alias names; do not add unless it materially simplifies real duplicate handling.
