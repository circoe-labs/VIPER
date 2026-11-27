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
- Sites are ordered by `sort` (`name` default, `created`, `updated`; see `company-directory.md`),
  paginated by 50 and closed by default.
- The directory shows totals for all warehouse sites and their recorded interlocutors, independent
  of search and pagination. The interlocutor count is the number of contact entries across sites;
  the same person listed at two sites counts twice.
- Interlocutors can be checked « À contacter prochainement » and move to the top of each site.
  « Valider la sélection » saves all changed checkboxes on that site; before validation they are
  only a draft. The « À contacter » category shows the sites and saved checked contacts. The
  existing version check and audit trail apply; no message is sent.
- Details show the owner, location if known, interlocutors and source. The editor supports
  adding/removing interlocutors and changing site details. It does not send messages.
- Raw alternative email candidates (including “ou”) are preserved and visibly remain to verify.
- Existing protocol checks prevent source URLs from becoming script links.

## Warehouses from discovery missions

Accepting a discovered company (`find_prospects`, direct result or `viper_add_company`) creates,
in the same transaction, one warehouse record per accepted **warehouse site**, linked to the
company's establishment (`establishment_id`), so the directory shows the owning company
(`services/warehouse_discovery`).

- *Warehouse site*: its `kind` names an entrepôt, dépôt, hangar, warehouse, logistics site or
  platform (a head office, office or agency is not one unless it says « entrepôt »). A site
  without `kind` counts only if its name says entrepôt, warehouse or plateforme logistique.
- *Record*: the site's name (else « company — city »), address, postal code, city, SIRET; the
  cited source URL as `source_reference`; the trigger sentence, opening date and surface in
  `notes`. The category stays « À classer » and no interlocutor is invented, so the file reads
  « incomplete » until completed.
- *Duplicates*: a site matching a recorded warehouse (same SIRET, same name and place, or same
  address and a close name) creates none, and the existing record is left unchanged.
- *Review*: a pending result says, per company, how many warehouse records will be created and
  what happens to each site (computed on read).
- *Company already in the base*: discovery proposes it only for its **new warehouses** (review:
  « Entreprise existante + N fiche(s) entrepôt »), after the same human acceptance. Every
  identifier given (SIREN, site SIRET, name, e-mail domain) must agree on one company, and two
  different SIRENs never match. Acceptance adds the warehouse record and, when the company has
  no such establishment (same SIRET, city and name, or street address), one establishment. The
  company, its existing establishments and its signals are not touched; the trigger sentence is
  kept in the warehouse notes. Its other proposed sites are listed as refused, and a result with
  only recorded warehouses stays « déjà dans la base ». A pending result refused before this
  existed can be recomputed with « Recalculer la prévisualisation » (direct results only).
- Not covered: a company returned without any site creates no warehouse.

### Backfill of results accepted earlier

From `backend/` (target `VIPER_DATABASE_URL`); in production, inside the API container:
`docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env exec api python -m app.cli backfill-warehouses`.

1. `python -m app.cli backfill-warehouses` — dry run: lists each site of the accepted discovery
   results as `À CRÉER`, `DÉJÀ LIÉ`, `DOUBLON`, `PAS UN ENTREPÔT` or `SITE SUPPRIMÉ`, and each
   company accepted with `AUCUN SITE`. Nothing is written.
2. Review the list, then `python -m app.cli backfill-warehouses --apply`. `--exclude <id>` leaves
   a site out; `--include <id>` creates a « pas un entrepôt » site that is one (both repeatable,
   with the establishment id printed on the line; duplicates are never forced).

Running it again creates nothing new. Writes are audited as « Ligne de commande ».

## Warehouse mail drafts

The draft view has PME/TPE and other-company tabs. Selecting a common date preplans drafts
across both categories without authorizing dispatch. Each draft must then be reviewed and
validated individually; validation authorizes its scheduled dispatch and opens the next draft.
Validation checks the recorded name, warehouse, role, civilité and the DIHNAMO rule. When a
role or category is missing it must be completed on the warehouse record before validation.
Changing a validated message or its relevant warehouse details returns it to planned status.
Unknown or alternative email addresses must be resolved before validation.

Drafts can be reviewed, edited, validated and scheduled individually. Scheduling stores the
approved revision and the requested instant; the existing Contact dispatch worker sends due
warehouse messages through the connected Toolbox, subject to the same sending switch, recipient
allowlist and maximum lateness. An inactive dispatcher is shown in the editor. A scheduled mail
can be unscheduled until the worker claims it. The worker records a durable claim before contacting
the Toolbox; a timeout, error or interrupted send is never retried automatically, and the user
must check the mailbox before taking further action. The messages are separate from Contact
sequences and do not change a prospect's Contact status.
A scheduled warehouse mail that does not (certainly) leave keeps `failure_code` and `failed_at` (migration 0061,
backfilled from the audit log), cleared by a new plan or schedule. Contact › « Prospects entrepôt » lists every mail
waiting to leave (scheduled whatever the day, preplanned, sending, uncertain, failed), failures first, with the reason;
the section opens by itself when one needs attention.

The group action sets the same proposed date on all eligible drafts; it does not validate them.
The server checks every revision under lock and commits the whole batch or none of it. Editing a
preprogrammed draft retains its proposed date. A fresh group plan clears previous validations.

### Generated wording

`services/warehouse_draft_text.py` writes each draft; the naming rules are those of `mail_generation/naming.py`
(`contact.md`, *Subjects and naming*).
- *Subject*: names the company (the site label before its first dash), else the town, and a topic from the kind of
  function; the variant depends on the contact and is never one another warehouse draft already uses (the contact's name
  is appended only once every variant is taken).
- *Several companies* in the site label: neither the subject nor the text names one (« au sujet de votre activité »).
- *Function*: short form (« Directeur » for a long title); a company name inside the title is dropped.

Existing drafts are repaired by an operator command, from `backend/`:

    python -m app.cli warehouse-drafts-rewrite           # dry run: lists the changes, writes nothing
    python -m app.cli warehouse-drafts-rewrite --apply

It replaces only text the former template generated (its five fixed subjects, the company sentence, the sentences
holding the long title). Drafts being sent, uncertain or sent, and drafts saved by hand from the editor, are never
touched. A changed draft loses its validation and programming (it keeps its proposed date) and is audited
`warehouse_draft.rewritten`. Running it again changes nothing.

## Workbook import

Authenticated, CSRF-protected endpoints:

- `GET /api/warehouses`, `GET /api/warehouses/counts`, `GET /api/warehouses/{id}`
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

## Hors prospection

A mail to the address of a person out of prospecting, or for the warehouse of an archived or excluded company, is
refused and, when already planned or scheduled, becomes `failed` with the reason
([`prospecting-lifecycle.md`](prospecting-lifecycle.md)). A recipient that looks like someone else's is blocked the
same way until corrected or confirmed ([`email-identity.md`](email-identity.md)).
