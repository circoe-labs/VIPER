# Excel Import / Export Contract — reviewed

## Observed private workbook structure

The real workbook `BASE_CLIENT.xlsx` contains 339 data rows on `Base client ` and 24 columns, plus an `actualité` sheet. Non-PII profiling is documented in `legacy-data-profile.md`.

Historical columns:
1. Référent
2. A contacter 
3. Entreprise
4. rdv obtenu
5. Devis envoyé
6. Suivi
7. Relance 1
8. relance 2
9. Mode de contact
10. Catégorie
11. Civilité 
12. Nom
13. Prénom
14. Fonction
15. Mail
16. Téléphone
17. Mobile
18. Adresse 
19. Projet déjà réalisé avec l'entreprise
20. Type de projet
21. Liste des fiches projets_references_CIRCOE.csv
22. Approche client
23. A contacter
24. unnamed/empty column

## Important observed anomalies

- `Référent` mixes real internal names with `v`, `xxx`, `?`, retirement/death/RDV notes and even email-like text. Only genuine internal referents may map to Referent.
- first `A contacter ` contains `s37`, `s39`, and `retraité`; `retraité` is not a week and must be flagged, with a possible user-confirmed suggestion of `Inactive`.
- second `A contacter` contains `Oui/OUI`; its semantics remain legacy metadata until confirmed.
- `Mode de contact` contains `Commercial`, `Commerciale`, `Auto`; preserve raw and do not silently map to commercial segment.
- civilities are inconsistent (`M.`, `MR`, `MME`, `MME.`, `M`, `0`-style anomaly); normalize only through explicit rules and flag invalid values.
- category includes an invalid/non-category value (`Non` observed); flag for review.
- historical RDV/devis/suivi/relance columns are currently empty in the real workbook, so stage mapping must be tested with synthetic fixtures as well.
- address is currently empty in the real workbook.
- duplicate emails and company-name repeats/variants exist; preview must not silently create duplicates.

## Mapping intent

- `Entreprise` → Company.
- `Catégorie` → one or more company activity categories after normalization/review.
- `Civilité`, `Nom`, `Prénom` → Prospect.
- `Fonction` → `exact_job_title` + role suggestion.
- `Mail` → Email record, primary by default when unique.
- `Téléphone`/`Mobile` → Phone records with type.
- `Adresse` → company Establishment/address, never Prospect.
- project/type/references/approach → company fields/legacy metadata as appropriate.
- `Référent` → internal referent only for recognized values.
- `S37/S39` → planned-contact candidate requiring year/context; never invent year.
- stage booleans → normalized contact-tracking status when data exists; conflicts require visible review.
- unknown/ambiguous columns → lossless `import_row_metadata.legacy_metadata`.

## Import UX

Drag/drop → parse → choose/confirm sheet → preview → map → validation/anomaly flags → dedup candidate review → row corrections/exclusions → explicit commit.

Preview must show machine-readable + human-readable diagnostics for missing identity/company, invalid civility/category, role mapping, ambiguous referent/week values, duplicate email/company candidates, contactability conflicts and unknown columns.

Import must never reactivate a permanently blocked/do-not-contact prospect.

The extra `actualité` sheet is outside the V1 prospect-import model. The UI must explicitly say it is skipped rather than silently ignoring it.

## Export semantics

Export is rebuilt from the normalized DB and must correct legacy semantic mistakes:
- separate `Référent`, `Statut activité`, and verification date;
- export real planned contact date; optionally include derived week for user convenience;
- export a single clear contact-tracking status rather than five booleans;
- expose `Do not contact` distinctly from `Non intéressé`;
- export primary email/phone in compatibility columns and define a deterministic way to include aliases (additional alias sheet or explicit extra columns);
- preserve relevant opaque legacy metadata without silently dropping it.

The grill established a **priority order** rather than a final immutable column list: Referent first, then company/contact-planning context, communication/classification, identity/role, then tracking/outcome fields. Because verification/status fields were added later and legacy booleans were consolidated, exact final ordering remains configurable in one centralized export specification.

## Round-trip meaning

Round-trip means useful information survives import → normalization → edits → export. It does **not** mean reproducing historical misuse (`xxx/?` in Referent) or exact legacy layout mistakes.

No live bidirectional Excel synchronization in V1.

---

## Import engine — as implemented (Task 08)

Pure, deterministic engine in `backend/app/services/imports/` ([ADR-0007](../adr/0007-import-engine.md),
decisions I-50 … I-59). Entry point:

```python
build_preview(ImportFile(filename, content), reference: ImportReferenceData,
              mapping: ImportMapping | None = None, *, limits: ImportLimits = DEFAULT_LIMITS) -> ImportPreview
```

- **No side effects**: no database, clock, randomness or network; the same bytes, reference snapshot and mapping
  always give the same JSON (`preview.model_dump(mode="json")`). A test runs it with sockets disabled and another
  checks that no engine module imports `sqlalchemy`, `app.db`, `app.repositories` or ORM models.
- **Reference data** is a plain snapshot (`reference.py`): roles, activity categories, commercial segments
  (active *and* inactive), internal referents, companies, prospects with their emails and contactability.
  `reference_loader.load_reference_data(session)` builds it with SELECTs only (Task 09 calls it per preview).
- **Rejections**: a file that cannot be read at all raises `ImportRejectedError` (subclass of
  `InvalidInputError`) carrying a catalogue diagnostic (`file.*`, `sheet.too_many_*`, `mapping.*`); library
  errors are never chained (their text may quote cell values).
- **Everything else is a diagnostic** attached to the batch (`summary.notices`) or to a row, never an exception.

Pipeline: `workbook.py` (adapters) → `layout.py` (sheet + columns; legacy headers only in `fields.py`) → `rows.py`
(normalizers in `normalize.py`, matching in `matching.py`) → `dedup.py` → `preview.py` (summary).

### File adapters and limits

| Input | Rules |
|---|---|
| `.xlsx`, `.xlsm` | openpyxl 3.1.5, read-only, `data_only` (cached values, never formulas; a formula never computed by Excel reads as empty). Typed values kept (numbers, dates). Every sheet is listed, chart sheets included. |
| `.csv`, `.tsv`, `.txt` | UTF-8 (BOM allowed), UTF-16 with BOM, else Windows-1252 with notice `file.encoding_fallback`. Delimiter sniffed among `;`, `,`, tab on the first 50 records (most records of one consistent width > 1; tie → `;`). Quoted fields may hold delimiters and line breaks; row numbers are record numbers. |
| OLE container | `file.encrypted` when it holds an `EncryptionInfo` stream (password-protected `.xlsx`), else `file.legacy_xls`. |
| Anything else | `file.unsupported_format`; unreadable zip/XML → `file.corrupt`. |

- Only **non-empty rows** are kept, with their source row number; trailing empty cells are trimmed. Blank rows
  between the header and the last data row are counted (`summary.rows_empty`).
- **Merged cells**: read-only openpyxl does not expose them, so merge ranges are read from the sheet XML with the
  standard library. The value of a *vertical* merge is copied down its first column on rows that have other content
  (`cell.merged_value_copied`, `sheet.merged_cells`); horizontal merges copy nothing.
- **Width**: content width, or the sheet's declared used range when it is wider and within the column limit — so
  the historical trailing unnamed column is reported.
- **Limits** (settings, `ImportLimits.from_settings`): `VIPER_IMPORT_MAX_FILE_MB` (10), `VIPER_IMPORT_MAX_ROWS`
  (5000 non-empty rows per sheet), `VIPER_IMPORT_MAX_COLUMNS` (100). The unzipped size of an XLSX may not exceed
  10 × the file limit (zip-bomb guard). Past a limit the whole file is rejected with a clear French message.

### Sheet recognition

The prospect sheet is the one whose header row — searched in its first 10 non-empty rows — names the most known
fields, at least 3 of them including one identity field (`Entreprise`, `Nom`, `Prénom`, `Mail`). Ties go to the
first sheet. Every other sheet gets `sheet.skipped` (the historical `actualité` sheet included); no candidate at
all gives `sheet.not_found` and no rows. The historical sheet name `Base client ` (trailing space) plays no role.

### Column mapping

Headers are compared folded (lowercase, no accents, punctuation and underscores as spaces, trimmed). Historical
columns, in workbook order:

| Col | Historical header | Field (`ImportField`) | Target |
|---|---|---|---|
| A | `Référent` | `referent` | contact tracking `referent_id` — recognised internal referents only |
| B | `A contacter ` (1st) | `planned_contact` | contact tracking `planned_contact_at` candidate (week/date) |
| C | `Entreprise` | `company_name` | company `display_name` (+ in-file company key) |
| D | `rdv obtenu` | `stage_appointment` | tracking status `appointment_obtained` (a date → `appointment_date`) |
| E | `Devis envoyé` | `stage_quote_sent` | tracking status `quote_sent` |
| F | `Suivi` | `stage_quote_follow_up` | tracking status `quote_follow_up` |
| G | `Relance 1` | `stage_follow_up_1` | tracking status `follow_up_1` |
| H | `relance 2` | `stage_follow_up_2` | tracking status `follow_up_2` |
| I | `Mode de contact` | `contact_mode` | **legacy metadata only** (raw; never a commercial segment) |
| J | `Catégorie` | `category` | company activity categories (suggestions) / segment suggestion |
| K | `Civilité ` | `civility` | prospect `civility` (`mr` / `ms`) |
| L | `Nom` | `last_name` | prospect `last_name` |
| M | `Prénom` | `first_name` | prospect `first_name` |
| N | `Fonction` | `job_title` | prospect `exact_job_title` + role suggestions |
| O | `Mail` | `email` | email records (first valid = primary) |
| P | `Téléphone` | `phone` | phone records |
| Q | `Mobile` | `mobile` | phone records |
| R | `Adresse ` | `address` | company establishment address (never the prospect) |
| S | `Projet déjà réalisé avec l'entreprise` | `project_done_with_circoe` | company field |
| T | `Type de projet` | `project_type` | company field |
| U | `Liste des fiches projets_references_CIRCOE.csv` | `circoe_references` | company field |
| V | `Approche client` | `client_approach` | company field |
| W | `A contacter` (2nd) | `legacy_to_contact_flag` | **legacy metadata only** (`Oui/OUI`, meaning unconfirmed) |
| X | *(unnamed)* | — | legacy metadata (`column.unnamed` notice) |

Accepted aliases (e.g. `Société`, `E-mail`, `Courriel`, `Portable`, `Rendez-vous obtenu`, `Poste`) are listed in
`fields.py`. The repeated `A contacter` header is disambiguated **by position** (`matched_by = position`). Any
other repeated header, unknown header or unnamed column is kept raw (`column.duplicate_header`,
`column.unmapped`, `column.unnamed`); `Mode de contact` and the second `A contacter` get
`column.legacy_preserved`. Missing columns: `column.missing_key` (warning) for `Entreprise`, `Nom`, `Prénom`,
`Mail`, `column.missing` (info) for the others.

**User overrides** (`ImportMapping`, for Task 09): `sheet` (any sheet, even without a recognisable header — its
first row then serves as headers), `header_row`, and `columns: {letter: field | None}`. A field assigned by an
override is taken away from the column that had it; `None` keeps a column raw. Unknown sheet/column, invalid
header row or a field mapped twice → `ImportRejectedError` (`mapping.*`).

### Normalization rules

| Field | Rule |
|---|---|
| Civility | Folded, dots/spaces ignored: `m`, `mr`, `monsieur` → `mr`; `mme`, `madame`, `mlle`, `melle`, `mademoiselle`, `ms`, `mrs` → `ms`. Anything else (`0`, `Dr`, notes) → `civility.invalid`, empty, raw kept. |
| Names | Whitespace collapsed. A name typed entirely in upper or lower case gets capitalised parts (`JEAN-PIERRE` → `Jean-Pierre`), inner particles lowercase (`JEAN DE LA FONTAINE` → `Jean de la Fontaine`, `MARIE D'ARC` → `Marie d'Arc`); mixed case is kept as typed. No first nor last name → `prospect.missing_name` (**error**: the schema requires one); only one → `prospect.partial_name`. Longer than 100 characters → `value.too_long`, raw kept. |
| Company | Trimmed, casing kept (acronyms). Missing → `company.missing` (warning; `company_id` stays nullable until the review). Without a company, company-level cells (category, project fields, address) are still diagnosed and kept raw. |
| Text fields | Company project/type/references/approach keep their line breaks; a lone `0` (number or text) is a placeholder → `value.zero_placeholder`, field empty, raw kept. Database lengths enforced (`value.too_long`). |
| `Fonction` | `exact_job_title` = trimmed text. Role suggestions against the reference roles: exact folded label or slug (active → no confirmation; inactive → `role.inactive_match`), then every word of a role label present in the title (`contains`, 0.9) or close spelling (`similar`, ratio ≥ 0.8), ranked; none → `role.unmatched`. **Never** a new role. |
| `Catégorie` | Numeric prefix `N. ` removed. The whole cell is matched first; otherwise split on `/`, `;`, `,`, `+`, `\|`, line break — **never** on `&` or `et` (historical labels contain them). Each part: exact category, suggestion (`category.suggested`), inactive (`category.inactive_match`), exact commercial-segment label (`category.segment_suggested`, company segment suggestion to confirm) or unmatched (`category.unmatched`, listed in `unmatched_categories`). Yes/no markers, `x`, `?`, numbers, `n/a`… → `category.invalid`. Raw kept unless every part matched exactly. |
| `Référent` | Only a recognised internal referent: full name in either order (exact), or a unique first name / last name / initial + last name (`referent.partial_match`, to confirm); several → `referent.ambiguous`; only a deactivated one → `referent.inactive`. Markers `v`, `x`, `xxx`, `?`, `ok`… → `referent.marker`; anything with `@` → `referent.email_like` (even a referent's own address); week codes → `referent.week_marker`; one to three words of letters → `referent.unknown`; other text → `referent.note` (a departure hint also suggests `inactive`). Unmatched values are kept raw and **never** become a referent. |
| 1st `A contacter` | `S37`, `s39`, `S 37`, `sem. 37` → week **without year** (`planned_contact.week_without_year`, `requires_year`, no date, raw kept — the year is never guessed). `S37 2026`, `S37/26`, `2026-W37` → Monday of that ISO week. A date cell or `dd/mm/yyyy` → that date. Impossible week → `planned_contact.invalid_week`. Anything else → `planned_contact.not_a_week`, raw kept; `retraité`, `décédé`, `plus en poste`… also suggest activity `inactive` (`activity.inactive_suggested`, to confirm; import never sets activity). |
| Stage columns | Positive: `oui`, `x`, `ok`, `fait`, `1`, `v`, check marks, `TRUE`, non-zero numbers, dates, `oui …`. Negative: `non`, `0`, `FALSE`, dashes. Other text → `tracking.stage_unrecognized`, raw kept. The **most advanced positive stage wins** (enum order `follow_up_1` < `follow_up_2` < `appointment_obtained` < `quote_sent` < `quote_follow_up`). Conflict (`tracking.stage_conflict`, `requires_review`): a negative stage below the winning one, `Relance 2` without `Relance 1`, `Suivi` without `Devis envoyé`. Dates and non-plain values of stages other than `rdv obtenu` are kept raw. A tracking proposal exists when a stage is positive, a planned contact was read or a referent was recognised (status `to_contact` otherwise). |
| `Mail` | Split on spaces, `;`, `,`, `/`, `\|`; lowercased; `mailto:` and wrapping punctuation removed; syntax-checked (`local@domain.tld`, ≤ 320). Valid addresses kept in order, first = primary (`email.multiple_in_cell`); any invalid part → `email.invalid`, raw kept. The company `email_domain` is the first non-webmail domain of the row. |
| `Téléphone`, `Mobile` | Split on `/`, `;`, `,`, `\|`, line break, ` ou `, ` - `. French numbers (`06 00 00 00 01`, `+33 (0)6…`, `0033…`) → `+33XXXXXXXXX`; other `+`/`00` numbers keep their digits; a number typed as a number that lost its leading zero (9 digits) is restored (`phone.leading_zero_restored`); other digit strings not starting with `0` are kept as typed (`phone.unrecognized_format`); letters or wrong length → `phone.invalid`, raw kept. Type by the French numbering plan (06/07 mobile, 01–05/09 landline, 08 other), else by column (`Mobile` → mobile, `Téléphone` → other). Duplicates across both columns dropped. **Primary = first mobile number, else the first number.** |
| `Adresse` | `12 rue X, 69000 Lyon` → line 1, postal code, city (country only when `France` is written); otherwise free text (first line / other lines, `address.unstructured`, raw kept). Attached to the company's establishment proposal, never to the prospect; without a company → `address.without_company`. |

### Legacy metadata (lossless)

`PreviewRow.legacy_metadata` — the future `import_row_metadata.legacy_metadata` — maps a key to
`{column, header, value, reason}` with the raw JSON value:

- key = the field value for mapped columns (`contact_mode`, `legacy_to_contact_flag`, `referent`, `civility`, …),
  `column_<letter>` for unmapped ones;
- reason `opaque_field` (kept raw by design), `unmapped_column`, or `not_mapped_value` (the value was invalid,
  partial, a guess or not storable as is — e.g. a week without its year).

Every non-empty source cell is listed in `PreviewRow.cells` with `mapped` (a proposed field carries it) and/or
`preserved` (it is in legacy metadata); a final pass preserves any cell no rule consumed. A property test over 300
generated rows checks that every cell is mapped or preserved, that preserved values equal the source, and that
`mapped` cells are really represented in the proposal.

### Duplicates and contactability

Candidates only, never decisions (`PreviewRow.duplicates`, `CompanyProposal.candidates`):

| Candidate | Reason | Confidence | Diagnostic |
|---|---|---|---|
| Other file row | same normalized email | 1.0 | `duplicate.email_in_file` (`summary.duplicate_email_groups` counts addresses shared by several rows) |
| Other file row | same folded first + last name and company key | 0.9 | `duplicate.person_in_file` |
| Existing prospect | same email | 1.0 | `duplicate.email_existing` |
| Existing prospect | same names and company key | 0.9 | `duplicate.person_existing` |
| Existing prospect | same names, other/no company | 0.5 | `duplicate.person_name_existing` (info) |
| Existing company | same company key (1.0 when the folded display name is identical) | 0.9 | `company.existing_match` (info) |
| Existing company | same non-webmail email domain | 0.7 | `company.likely_match` |
| Existing company | key spelling ratio ≥ 0.85 | 0.6 | `company.likely_match` |

The **company key** folds the name, drops dots, reads `&` as `et` and removes legal forms (`SARL`, `SAS`, `SASU`,
`SA`, `EURL`, `SNC`, `SCI`, `SCOP`, `GIE`, `SELARL`, `Sté`, `Société`, `GmbH`, `Ltd`…): rows sharing it are one
company in the file (`company.variant_in_file` when spelled differently, `company.field_conflict` when their
company-level values differ).

**Do-not-contact**: a row matching a `do_not_contact` prospect by email or by names + company gets
`contactability.do_not_contact` (**error**) and `blocked_by_do_not_contact = true`; the candidate carries
`contactability = do_not_contact`. Task 09 may only skip such a row or attach it to that prospect, which stays
blocked: proposals never carry a contactability value, so a merge cannot reactivate anybody (the database trigger
remains the last guard). A same-name-only match with a blocked prospect gives
`contactability.possible_do_not_contact` (warning).

### `ImportPreview` (JSON contract for Task 09)

- `summary`: file name/format/SHA-256 fingerprint, encoding and delimiter (CSV), prospect sheet and header row,
  every sheet with its status, the column mapping (`column`, `index`, `header`, `field`, `matched_by`),
  `rows_total`, `rows_empty`, `rows_by_status` (`ok`/`warning`/`error`), counts per severity and per code,
  `duplicate_email_groups`, batch `notices`.
- `rows[]`: `row_number`, `status` (worst severity), `company` (with categories, segment suggestion,
  establishment, candidates, `match_key`), `prospect` (civility, names, exact job title, role suggestions,
  activity suggestion), `emails`, `phones`, `tracking` (status, positive stages, `requires_review`, planned
  contact, appointment date, referent + suggestions), `legacy_metadata`, `duplicates`, `blocked_by_do_not_contact`,
  `diagnostics`, `cells`.
- Diagnostics: `{code, severity, message, row, column, field, value}` — the message is French and never contains a
  cell value; the offending raw value is in `value`.

### Diagnostic catalogue

Severity: **error** — the row (or file) cannot be imported as is; **warning** — importable, review recommended;
**info** — what the engine did. Source of truth: `backend/app/services/imports/diagnostics.py` (a test checks this
table lists every code).

| Code | Severity | Message (French, `{…}` = placeholder) |
|---|---|---|
| `file.empty` | error | Le fichier est vide. |
| `file.too_large` | error | Le fichier dépasse la taille maximale autorisée ({limit_mb} Mo). |
| `file.unsupported_format` | error | Format non pris en charge : importez un classeur Excel (.xlsx) ou un fichier CSV. |
| `file.encrypted` | error | Le classeur est protégé par un mot de passe : enregistrez-en une copie sans mot de passe puis importez-la. |
| `file.legacy_xls` | error | Ancien format Excel 97-2003 (.xls) non pris en charge : enregistrez le fichier en .xlsx. |
| `file.corrupt` | error | Le fichier est illisible ou endommagé. |
| `file.encoding_unknown` | error | Encodage du fichier CSV non reconnu : enregistrez-le en UTF-8. |
| `file.encoding_fallback` | info | Fichier CSV lu en Windows-1252 (il n'est pas en UTF-8) : vérifiez les accents. |
| `sheet.too_many_rows` | error | La feuille « {sheet} » dépasse le nombre maximal de lignes ({limit}). |
| `sheet.too_many_columns` | error | La feuille « {sheet} » dépasse le nombre maximal de colonnes ({limit}). |
| `sheet.not_found` | error | Aucune feuille ne ressemble à une liste de prospects : en-têtes attendus introuvables. |
| `sheet.skipped` | info | Feuille « {sheet} » ignorée : elle ne fait pas partie du modèle d'import des prospects. |
| `sheet.merged_cells` | info | Feuille « {sheet} » : {count} plage(s) de cellules fusionnées ; la valeur d'une fusion verticale est recopiée sur chacune de ses lignes. |
| `mapping.unknown_sheet` | error | Feuille « {sheet} » introuvable. |
| `mapping.invalid_header_row` | error | La ligne {row} ne peut pas servir de ligne d'en-têtes (vide ou hors de la feuille). |
| `mapping.unknown_column` | error | Colonne {column} inexistante. |
| `mapping.duplicate_field` | error | Le champ « {label} » est associé à plusieurs colonnes. |
| `mapping.unknown_row` | error | La ligne {row} ne fait pas partie des lignes importées de la feuille. |
| `mapping.uncorrectable_field` | error | Le champ « {label} » ne peut pas être corrigé : il n'est associé à aucune colonne ou se règle par une association groupée. |
| `column.unmapped` | info | Colonne {column} « {header} » non reconnue : ses valeurs sont conservées telles quelles. |
| `column.unnamed` | info | Colonne {column} sans en-tête : ses valeurs éventuelles sont conservées telles quelles. |
| `column.duplicate_header` | warning | Colonne {column} « {header} » en double : ses valeurs sont conservées telles quelles, à réaffecter si besoin. |
| `column.legacy_preserved` | info | Colonne {column} « {header} » conservée telle quelle : sa signification n'est pas confirmée. |
| `column.missing_key` | warning | Colonne « {label} » absente du fichier. |
| `column.missing` | info | Colonne « {label} » absente du fichier. |
| `cell.merged_value_copied` | info | Valeur recopiée depuis une cellule fusionnée. |
| `value.too_long` | warning | Valeur trop longue pour « {label} » ({limit} caractères au plus) : ignorée, valeur d'origine conservée. |
| `value.zero_placeholder` | info | Valeur « 0 » considérée comme vide ; valeur d'origine conservée. |
| `prospect.missing_name` | error | Ni nom ni prénom : le prospect ne peut pas être créé. |
| `prospect.partial_name` | warning | Nom ou prénom manquant. |
| `company.missing` | warning | Entreprise manquante : le prospect ne sera rattaché à aucune entreprise. |
| `civility.invalid` | warning | Civilité non reconnue (M. ou Mme attendu) : laissée vide, valeur d'origine conservée. |
| `role.suggested` | info | Rôle proposé d'après la fonction : à confirmer. |
| `role.unmatched` | warning | Aucun rôle existant ne correspond à la fonction : à associer, créer ou laisser vide. |
| `role.inactive_match` | warning | La fonction correspond à un rôle désactivé : à réactiver ou à remplacer. |
| `category.suggested` | info | Catégorie d'activité proposée : à confirmer. |
| `category.unmatched` | warning | Catégorie d'activité inconnue : à associer, créer ou ignorer ; valeur d'origine conservée. |
| `category.invalid` | warning | Valeur qui n'est pas une catégorie d'activité : ignorée, valeur d'origine conservée. |
| `category.inactive_match` | warning | La valeur correspond à une catégorie d'activité désactivée : à réactiver ou remplacer. |
| `category.segment_suggested` | info | La valeur correspond à un segment commercial : proposé pour l'entreprise, à confirmer. |
| `referent.marker` | warning | Marqueur historique (v, xxx, ?…) : ce n'est pas un référent interne ; valeur d'origine conservée. |
| `referent.email_like` | warning | Adresse e-mail : ce n'est pas un référent interne ; valeur d'origine conservée. |
| `referent.week_marker` | warning | Semaine de contact : ce n'est pas un référent interne ; valeur d'origine conservée. |
| `referent.note` | warning | Note libre : ce n'est pas un référent interne ; valeur d'origine conservée. |
| `referent.unknown` | warning | Référent interne inconnu : à créer dans les paramètres ou à laisser vide ; valeur d'origine conservée. |
| `referent.partial_match` | warning | Référent reconnu partiellement (prénom, nom ou initiale seul) : à confirmer. |
| `referent.ambiguous` | warning | Plusieurs référents internes correspondent : à choisir ; valeur d'origine conservée. |
| `referent.inactive` | warning | Le référent correspond à une personne désactivée : à confirmer. |
| `planned_contact.week_without_year` | warning | Semaine de contact sans année : préciser l'année (jamais devinée) ; valeur d'origine conservée. |
| `planned_contact.not_a_week` | warning | Ni une semaine ni une date de contact : ignorée, valeur d'origine conservée. |
| `planned_contact.invalid_week` | warning | Numéro de semaine impossible : ignoré, valeur d'origine conservée. |
| `activity.inactive_suggested` | warning | Statut d'activité « Inactif » suggéré (retraite, départ…) : à confirmer. |
| `tracking.stage_conflict` | warning | Étapes de suivi contradictoires : l'étape la plus avancée est proposée, à vérifier. |
| `tracking.stage_unrecognized` | warning | Valeur d'étape de suivi non reconnue : ignorée, valeur d'origine conservée. |
| `email.invalid` | warning | Adresse e-mail invalide : ignorée, valeur d'origine conservée. |
| `email.multiple_in_cell` | info | Plusieurs adresses e-mail dans la cellule : la première valide devient principale. |
| `phone.invalid` | warning | Numéro de téléphone invalide : ignoré, valeur d'origine conservée. |
| `phone.leading_zero_restored` | warning | Numéro saisi comme un nombre : le 0 initial a été restauré, à vérifier. |
| `phone.unrecognized_format` | warning | Numéro sans indicatif ni format français : conservé tel quel, à vérifier. |
| `phone.multiple_in_cell` | info | Plusieurs numéros dans la cellule. |
| `address.unstructured` | info | Adresse sans code postal reconnu : conservée en texte libre. |
| `address.without_company` | warning | Adresse sans entreprise : elle ne peut être rattachée à aucun établissement ; valeur d'origine conservée. |
| `company.field_conflict` | warning | « {label} » a une autre valeur sur une autre ligne de la même entreprise. |
| `company.variant_in_file` | info | Même entreprise écrite autrement sur d'autres lignes du fichier. |
| `company.existing_match` | info | Entreprise déjà présente dans la base : rattachement proposé. |
| `company.likely_match` | warning | Entreprise proche d'une entreprise existante (nom ou domaine e-mail) : à vérifier. |
| `duplicate.email_in_file` | warning | Adresse e-mail présente sur plusieurs lignes du fichier. |
| `duplicate.person_in_file` | warning | Même personne (nom, prénom, entreprise) sur plusieurs lignes du fichier. |
| `duplicate.email_existing` | warning | Adresse e-mail déjà connue dans la base. |
| `duplicate.person_existing` | warning | Personne déjà présente dans la base (mêmes nom, prénom et entreprise). |
| `duplicate.person_name_existing` | info | Homonyme dans la base (mêmes nom et prénom, autre entreprise). |
| `contactability.do_not_contact` | error | Correspond à un prospect « Ne pas contacter » : l'import ne peut ni le recréer ni le réactiver. |
| `contactability.possible_do_not_contact` | warning | Homonyme d'un prospect « Ne pas contacter » : à vérifier avant import. |

### Private compatibility smoke

`backend/tests/test_import_private_workbook.py` (marker `private`, skipped unless `VIPER_PRIVATE_WORKBOOK` points to
the real workbook, never in CI) asserts the structure (prospect sheet, 339 rows, 3 blank rows, `actualité`
skipped, 24 columns with W by position and X unnamed, 3 duplicate-email groups, expected anomaly codes, no
unaccounted cell, determinism) and prints counts per diagnostic code only. Command in the runbook.

---

## Import review and commit — as implemented (Task 09)

Page **Importer un fichier Excel**, `/prospection/import` (secondary page of Prospection; entry points « Importer
Excel » in the Prospection header (Task 14) and the Entreprises header). Design:
[ADR-0012](../adr/0012-stateless-import-review.md); decisions I-72 … I-79. Code: `backend/app/services/imports/`
(`review.py`, `decisions.py`), `backend/app/services/import_commit.py`, `backend/app/api/routes/imports.py`,
`frontend/src/imports/`.

### Workflow

1. **Fichier** — drag and drop or « Choisir un fichier » (`.xlsx`, `.xlsm`, `.csv`, 10 Mo). The file stays in the
   browser: it is sent for analysis (and again at commit), never stored.
2. **Feuille** — detected prospect sheet (rows, header row, blank rows), every skipped sheet with the engine's reason
   (`actualité` → « … ne fait pas partie du modèle d'import des prospects »), the column correspondence, a sheet
   picker (re-analysis) and the **re-import warning** when a committed batch has the same SHA-256.
3. **Vérification** — summary tiles (Lignes, Sans remarque, À vérifier, En erreur, Exclues) and one chip per row-level
   diagnostic code with its count; tiles and chips filter the row table. Two tabs:
   - **À résoudre** — sections *Erreurs à traiter* (no name, merge into an excluded row: « Corriger », « Exclure », bulk
     exclusion), *Opposition « Ne pas contacter »*, *Doublons* (rows with candidates, companies with existing
     candidates), *Rôles non reconnus*, *Catégories d'activité*, *Référents*, *Semaines sans année*, *Civilités non
     reconnues*, *Activité (retraite, départ…)*. One control per raw value, applied to every row carrying it.
   - **Lignes** — search (row number, names, company, e-mail), status filter, remark filter, 25 rows per page; a row
     opens on its remarks, what will be imported, its duplicate choice, the correction form (« Appliquer et relancer
     l'analyse ») and its preserved original values.
   A sticky bar shows how many rows will be imported/excluded and blocks « Importer… » while an error is unresolved
   (warnings never block).
4. **Import** — confirmation dialog: prospects created, rows completing existing prospects, merged rows, companies
   created/completed, roles and categories created, weeks dated/undated, rows excluded; the **legal basis or
   collection context** (required, prefilled « Fichier historique Circoe — prospection B2B ») and an optional
   **source reference**; the re-import acknowledgement when needed. Then the result (counts, links to the batch's
   sources and traced rows in the Database Explorer) and the history (last 20 batches: date, file, user,
   imported/total, excluded, status).

### Decisions model (`decisions.ImportDecisions`, all overrides of the review's defaults)

| Decision | Keyed by | Values | Default |
|---|---|---|---|
| Corrections | row → field | text replacing the cell (`null` clears it); fields `company_name`, `civility`, `last_name`, `first_name`, `job_title`, `email`, `phone`, `mobile`, `address`, `planned_contact` | none |
| Role | folded job title | `none` · `existing(role_id)` · `create(label)` | the exact active role, else none (suggestions only offered) |
| Category | folded category token | `ignore` · `existing(category_ids)` · `create(label)` · `segment(segment_id)` | the exact active category, else ignore |
| Referent | folded raw value | `ignore` · `existing(referent_id)` | the exact active referent, else ignore (markers, notes, e-mails, partial/ambiguous/inactive matches) |
| Civility | folded invalid value | `mr` · `ms` · `null` | `null` |
| Week year | batch `week_year`, per week `weeks[n]` | a year (2000–2100) or `null` | no year → no date (never guessed) |
| Company | company key | `create` · `link(company_id)` | link to the single best existing company with the same key, else create |
| Row resolution | row | `create` · `attach(prospect_id)` · `attach_row(row)` · `exclude` | do-not-contact match → exclude; same e-mail or same names + company as an existing prospect → attach to the best one; same names + company as an earlier row → merge into it; else create |
| Inactive | row | `true` confirms the engine's `inactive` suggestion | `false` |
| Provenance | batch | `legal_basis_or_collection_context` (required), `source_reference` | — |
| Re-import | batch | `acknowledge_reimport` | `false` |

Validation (`review.plan_import`, 422 `invalid_decisions` with `{code, row, group, key}`): `unknown_row`,
`unknown_key`, `unknown_value` (id not in the snapshot), `invalid_week_year` (week 53), `inactive_not_suggested`,
`missing_name` (create without any name), `blocked_by_do_not_contact` (a blocked row may only be excluded or attached
to the blocked prospect), `not_a_candidate` (attach target not among the row's candidates), `attached_to_excluded`,
`attach_cycle`, `nothing_to_import`. A role or category to create whose label already exists → 409 `duplicate`.

### Merge rules (attach to an existing prospect, or merge into another row's prospect)

- Identity fields (civility, first/last name, exact job title, role) are **filled only when empty**; a different
  value is never written and stays in the row's legacy metadata.
- Company: set only when the prospect has none (through `prospects.change_company`, so employment verification is
  cleared and verified channels are re-flagged, I-13); a prospect's company is never replaced.
- E-mails and phones: added when the prospect does not have them (same address/number, active or not, is left as it
  is — never reactivated), `origin_type=imported`, `verification_status=unverified`, source reference
  `file / sheet / ligne n`; a new one becomes primary only when the prospect has no primary of that kind.
- Activity: `inactive` only when confirmed and the prospect's activity is `unknown`.
- Contact tracking: created when absent; an existing tracking keeps its stage and only gets empty dates/referent
  filled. A do-not-contact prospect gets no tracking from an import. Contactability is never read or written.
- Existing company (link): `companies.complete_company` fills empty e-mail domain, segment and Circoe texts, adds
  missing categories, and adds the address as primary establishment only when the company has none.

### Commit semantics

One savepoint of the request's transaction (ADR-0012): Settings values to create (by the user, `source=ui`) → batch
`pending` (by the user) → inside `import_batches.importing` (import actor on behalf of the user, I-29): companies
(+ establishment from the address) → prospects (+ channels, `employment_verified_at` NULL) or merges → contact
tracking through `save_contact_tracking` (status history) → per imported row an `excel_import` source (legal basis,
`file / sheet / ligne n`) and an `import_row_metadata` row (lossless legacy metadata, prospect and company ids) →
batch `committed` with `rows_total`, `rows_imported`, `rows_skipped` (+ the batch's legal basis and source reference,
migration 0006). A contact tracking is created only when a legacy stage, a dated planned contact or a referent is
applied. Dates without time (planned contact, appointment) are stored at midnight Europe/Paris.

Losslessness at commit: besides the engine's legacy metadata, a row keeps the raw value of anything the commit does
not apply — another spelling of its company, a company text that differs from the stored one, a second address, an
ignored exact category or referent, a value an existing prospect already holds differently, tracking values an
existing tracking or an opposition prevents. Every source row is either imported (created, attached or merged; one
row metadata each) or excluded (counted in `rows_skipped`, nothing written).

Failure: any exception rolls the savepoint back and records a `failed` batch (started/failed events, counts 0) that
the request commits; the API answers 500 `commit_failed` (422 when a value was refused) with the batch id and row.

### API — `/api/imports` (session + CSRF)

| Method & path | Body | Answer |
|---|---|---|
| `POST /imports/preview` | multipart `file`, optional `options` (JSON `{mapping, corrections}`) | `{review: {preview, digest, roles, categories, referents, weeks, civilities, companies, prospects, rows}, previous_imports}` |
| `POST /imports/commit` | multipart `file`, `decisions` (JSON `ImportDecisions`) | `{batch, counts}` (`prospects_created`, `prospects_attached`, `rows_merged`, `companies_created`, `companies_linked`, `emails_added`, `phones_added`, `trackings_created`, `roles_created`, `categories_created`, `rows_*`) |
| `GET /imports?limit=1..200` | — | batches, newest first (metadata only) |
| `GET /imports/{id}` | — | batch + `rows_traced`, `prospect_count`, `company_count` |

Refusals: `file_rejected` (422, or 413 when `Content-Length` exceeds the file limit + 2 MiB; carries the engine's
French `diagnostic`), `length_required` (411), `invalid_request` (422; schema errors with locations and types only,
never the submitted values), `file_changed` / `preview_outdated` / `reimport_not_acknowledged` (409),
`invalid_decisions` (422), `duplicate` (409), `commit_failed` (500/422), `not_found` (404). The body is parsed after
the session/CSRF guard.

### Engine additions (Task 09)

- `build_preview(..., corrections)` — per-cell corrections for the fields above; a row outside the data or a field
  without column → `mapping.unknown_row` / `mapping.uncorrectable_field`. `SourceCell.corrected` marks them and the
  original is kept as `<field>_original` with reason `corrected`.
- Fixed: a structured address lost its street line (`EstablishmentProposal` now forbids unknown fields).

### Private compatibility run (Task 09, manual)

Preview then commit of the real workbook into the throwaway worktree database with default decisions (the 11 rows
without any name excluded), aggregate output only, database reset afterwards: 339 rows (ok 3, warning 325, error 11),
groups to resolve — roles 117 (108 unknown, 8 suggested, 1 exact against the seeded roles), categories 12 (all
unknown), referents 12 (3 unknown names, 3 markers, 2 notes, 4 e-mail-like), 2 weeks without year, 1 invalid
civility, 253 companies (no existing candidate in an empty base); defaults 335 create, 4 merge into an earlier row.
Commit: 328 rows imported, 11 excluded, 324 prospects, 247 companies, 233 e-mails, 213 phones, 328 sources and row
metadata, 0 contact tracking (weeks left without year, no referent recognised); invariants checked (no opposition
touched, every row imported or excluded, one row metadata and one source per imported row, channels imported and
unverified, no employment verified).
