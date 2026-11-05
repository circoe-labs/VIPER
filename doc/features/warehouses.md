# Entrepôts

`/warehouses` is a separate directory of sites, property owners and source interlocutors.
It is accessible in the existing authenticated sidebar. A site can be recorded before its
legal company, postal address or SIRET is known. Missing values stay empty.

The original prospect, company, verification and Contact workflows are unchanged. Source
interlocutors in this directory do not create verified prospects or mailing sequences.

## Stored data

Migration `0021` adds only `warehouses`: site identity, optional owner and location fields,
notes, structured contacts (name, function, source email text, LinkedIn) and source reference.
The record and its contact list are saved atomically with an optimistic version. A concurrent
edit is refused rather than overwriting a newer record. All writes use the existing audit
service and a bound actor; the table's timestamp uses the existing database trigger.

The existing establishments model requires a known company and cannot represent an unassigned
warehouse or its separate property owner. No companies are invented to satisfy that relationship.
Actual company/establishment links can be introduced once they have been identified.

## Directory

- Search matches sites, owners, cities, SIRETs and source contacts, ignoring case and accents.
- Sites are ordered by name, paginated by 50 and closed by default.
- Details show the owner, location if known, interlocutors and source. The editor supports
  adding/removing interlocutors and changing site details. It does not send messages.
- Raw alternative email candidates (including “ou”) are preserved and visibly remain to verify.
- Existing protocol checks prevent source URLs from becoming script links.

## Workbook import

Authenticated, CSRF-protected endpoints:

- `GET /api/warehouses`, `GET /api/warehouses/{id}`
- `POST /api/warehouses`, `PUT /api/warehouses/{id}` (version required)
- `POST /api/warehouses/import-preview`, `POST /api/warehouses/import` (multipart `file`)

The preview reads compatible worksheets containing `Nom entrepôt` and `Prospect a contacter`.
Owner/function/email/LinkedIn columns are mapped by their position around those two headers,
including the repeated email headings and the shorter eight-column layout. Blank site cells
continue the preceding site's group, including vertically merged cells. A new site resets the
group. Overlapping worksheets do not duplicate identical interlocutors, and a blank owner in
one worksheet does not erase a value found in another. Conflicting owner values are reported.

Import is additive and atomic: existing normalized site names are skipped and never overwritten.
The response explicitly counts created/skipped sites. Imported identities also have unique
source keys, preventing duplicate commits. The source reference stores a basename and worksheet
names, not the person's absolute local filesystem path. The original workbook is never edited.

Files are limited to 16 MB, archives to 32 MB expanded, worksheets to 10,000 rows / 100 columns,
and imports to 2,000 sites. Invalid input aborts the transaction. No formulas or external links
are executed. Tests use synthetic records and the dedicated test/E2E databases only.
