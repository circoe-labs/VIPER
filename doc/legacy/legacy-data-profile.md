# Legacy Workbook Profile — non-PII observations

Private reference: `sources/BASE_CLIENT.xlsx`. Do not commit this file to the public repository.

Observed structure:
- sheet `Base client `: 339 data rows, 24 columns;
- sheet `actualité`: 7 data rows after header-like first row, outside the V1 prospect-import model;
- 333 rows contain an Enterprise value;
- 241 rows contain an email;
- 160 rows contain a Telephone value;
- 58 rows contain a Mobile value;
- 198 rows contain a Function/job-title value;
- 239 rows contain a Category;
- Address column is empty in the current workbook;
- RDV/Devis/Suivi/Relance 1/Relance 2 columns are empty in the current workbook;
- normalized email scan finds 3 duplicate-email groups (3 duplicate extra rows);
- coarse normalized company-name scan finds substantial repeated company names, so one company → many prospects is essential.

Notable anomalies to test without copying personal values into repository fixtures:
- Referent column contains both valid internal names and unrelated marker/note/email-like values;
- week/contact-plan column includes `S37`, `S39` and a retirement value;
- civilities use several variants plus an invalid numeric-like value;
- Category contains at least one value that is not a category;
- Mode de contact has `Auto`, `Commercial`, `Commerciale` variants;
- second `A contacter` field has `Oui/OUI` but unclear meaning;
- final unnamed column is empty.

These observations justify controlled preview/mapping rather than a direct spreadsheet-to-table dump.

## Structural findings from the Task 08 import engine (aggregates only)

Obtained by the private compatibility smoke (`backend/tests/test_import_private_workbook.py`) and shape-only
scans (letters/digits masked); no value was printed or copied.

- `Base client `: declared used range `A1:X343` — header on row 1, 342 rows below it of which 3 consecutive rows
  are blank (inside the range, near the end), hence **339 data rows**. No merged cells and no date-typed cells
  anywhere. Column X is inside the used range but has neither header nor value.
- `actualité`: 8 non-empty rows, a one-cell title row then 7 rows of 2 cells.
- Cell types: text everywhere except `Civilité` (3 integer `0`, the "0-style" anomaly) and `Type de projet`
  (246 integer `0` used as "nothing", 27 text values such as a number followed by words). `0` in a text column is
  handled as a placeholder (kept raw, `value.zero_placeholder`).
- `Catégorie`: 14 distinct values, most shaped `N. Label & Label` — a numeric prefix and `&` **inside** the label;
  38 cells contain `/`, separating two values. `Non` appears 3 times, always on rows without a company. Hence the
  split rule: never on `&`/`et`, on `/` (and `;`, `,`, `+`, `|`, line break), numeric prefix removed.
- `Référent`: 228 non-empty cells — 52 `v`, 49 `xxx`, 22 `?`, 4 email-like values, 2 free notes (one with digits,
  one with an arrow) and about 99 single words that look like internal first or last names (3 distinct). These
  can only become referents once the internal referents exist in Settings (Task 06); without them they are
  reported as `referent.unknown`.
- First `A contacter `: 101 cells — 100 week codes shaped letter + two digits (2 distinct values
  case-insensitively, none with a year) and 1 retirement word.
- Second `A contacter`: 6 cells, a single value case-insensitively. `Mode de contact`: 333 cells, 3 distinct values.
- Phones: all French 10-digit numbers written as text (`99 99 99 99 99`, one dotted, one irregularly spaced, about
  ten with a trailing space); no number-typed phone.
- `Mail`: 241 cells; 2 cells hold two addresses separated by ` / ` where the second one lacks the dot of its
  domain (first address kept, raw preserved, `email.invalid`). 3 duplicate-email groups (6 rows).
- Identity: 11 rows have neither first nor last name, 20 have only one of them, 6 have no company (one of them has a
  name). 8 rows are the same person (names + company key) as another row.
- `Entreprise`: 166 all-caps values, 4 untrimmed; the company key (legal forms, case, accents, punctuation
  ignored) finds 16 rows spelled differently from other rows of the same company, and 18 rows whose company-level
  values (e.g. `Projet déjà réalisé…`, 2 distinct values) differ from another row of the same company.
- `Fonction`: 198 cells, 28 all-caps and 31 all-lowercase.
