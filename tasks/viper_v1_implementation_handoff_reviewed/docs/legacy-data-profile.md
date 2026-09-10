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
