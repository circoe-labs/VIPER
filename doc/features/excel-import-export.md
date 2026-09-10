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
