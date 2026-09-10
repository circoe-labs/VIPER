# ADR-0013 — Normalized Excel export: one specification module, a multi-sheet workbook, typed and deterministic

- Status: accepted
- Date: 2026-09-11
- Deciders: Task 10 (Excel export), for orchestrator review
- Related: `doc/features/excel-import-export.md` (*Export — as implemented*), decision log I-83 … I-89, open
  questions #6 and #7, ADR-0007 (import engine, openpyxl), ADR-0012 (import commit), grill section C

## Context

The locked core loop ends with "download a refreshed Excel representation". The export must be rebuilt from the
normalized database, fix the legacy semantic mistakes (markers in `Référent`, week codes, five stage booleans,
opposition mixed with non-interest), keep aliases (several e-mails/phones per person) and the lossless legacy
metadata of the import without silent loss, and let the column order change without a migration. The workbook holds
personal data; spreadsheet programs evaluate formulas; a test must be able to compare two exports.

## Decision

1. **One specification module**, `app/services/exports/spec.py`: the sheets in order, each column with its French
   header, a value getter over projection records, a cell kind (`TEXT`, `CODE`, `DATE`, `DATETIME`, `INTEGER`,
   `RAW`) and a width. It is the only place knowing sheet or column names; reordering, renaming or adding a column
   is an edit there. The default order follows the grill's priorities (Référent → planning/company →
   classification → identity/role/verification/channels → company context → tracking/opposition → provenance → ids).
2. **Read from the domain, not from import rows**: `projection.py` loads every exported entity once (SELECTs only,
   `app/repositories/exports.py`) and resolves references into records; the legacy metadata of
   `import_row_metadata` appears only in its own sheet.
3. **A normalized workbook of seven sheets** — `Prospects` (one row per person, primary e-mail/phone in
   compatibility columns, company context denormalized for filtering), `Entreprises` (every company, with or
   without prospects), `Établissements`, `E-mails`, `Téléphones` (one row per alias with primary/active/verification/
   origin), `Provenance` (every source) and `Données d'origine` (one row per preserved legacy value). Secondary sheets
   are keyed by the stable ids (`ID VIPER`, `ID entreprise`) that the main sheet also carries, plus readable names.
4. **Typed and formula-free cells**: dates are real Excel dates on the Europe/Paris calendar; phones, SIREN, SIRET,
   postal codes and ids are text cells with the Text format; every text is forced to a string cell (openpyxl would
   make `=…` a formula and `#N/A` an error) and a text Excel would read as a formula when re-typed — the explorer
   CSV's rule, shared in `app/core/spreadsheet.py` — also gets the `quotePrefix` style. The value stays exact.
5. **Deterministic output**: rows sorted in Python with folded texts and the id as last tie-breaker; the generation
   date is an argument that sets the document properties and every zip entry's timestamp (a `ZipFile` subclass
   around openpyxl's `ExcelWriter`); no randomness. Same data + same date = same bytes.
6. **Delivery**: `GET /api/exports/workbook`, protected like every route (a GET: no CSRF, no domain write),
   generated in memory in the request, `Content-Disposition: attachment; filename="VIPER_export_YYYY-MM-DD.xlsx"`,
   `Cache-Control: no-store`, audited as `export.generated` with the signed-in user and counts only. Nothing is
   stored server-side. openpyxl write-only mode (already pinned for the import) streams rows to temporary files.

## Consequences

- Column changes are cheap and reviewable in one diff; tests compare the workbook headers with the specification,
  not with a copied list, and one test pins the documented semantic choices (Référent first, no stage booleans).
- The main sheet is readable for filtering and mail merges; complete, lossless data lives in the keyed sheets.
- The workbook is not a re-import format: the `Prospects` sheet's headers are close to the legacy ones where the
  meaning is the same (`Référent`, `Entreprise`, `Civilité`, `Nom`, `Prénom`, `E-mail`, `Téléphone`), but a round
  trip back through the import is not a V1 goal (no live synchronization).
- Cost is linear and dominated by openpyxl's pure-Python XML serializer: ≈ 10 s for 3 000 prospects with their
  aliases and legacy values (≈ 190 000 cells) on the development machine, < 1 s for the historical 339-row workbook.
  `lxml` would speed it up if the base grows by an order of magnitude (not added: a new native dependency).
- A text longer than Excel's 32 767-character cell limit is cut and XML-illegal control characters are dropped —
  the only transformations of stored values, both impossible to write otherwise.

## Alternatives considered

- **Secondary e-mails/phones as extra columns** (`E-mail 2`, `E-mail 3`…) — the column count depends on the data,
  so order and headers change between exports, and verification/origin per alias would multiply columns.
- **Legacy metadata as dynamic columns** on the main sheet — one column per legacy key and per merged row would make
  the layout data-dependent and lose the source row/column context; one row per value keeps it all.
- **Primary address only, no establishments sheet** — silently drops secondary establishments.
- **Apostrophe prefix as in the CSV** — in XLSX the apostrophe would become part of the visible value; typed string
  cells plus `quotePrefix` keep the exact value and never evaluate.
- **pandas / XlsxWriter** — new dependencies for what openpyxl, already pinned, does.
- **Filtering by Prospection criteria now** — the filter model is Task 14's; the endpoint path is fixed so its
  « Exporter Excel » button can reuse it and add parameters later.
