# Entrepôts

`/warehouses` is a separate directory of sites, property owners and source interlocutors.
It is accessible in the existing authenticated sidebar. A site can be recorded before its
legal company, postal address or SIRET is known. Missing values stay empty.

Source interlocutors stay in the listing; to be written to, a person becomes a **prospect**
(see *Warehouse people*). Drafting, validation, scheduling, sending and history are Contact's
([`contact.md`](contact.md)): there is one mail pipeline.

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

## Warehouse people

Owner: `services/warehouse_people.py`. Migration `0066` adds `warehouse_people` (listing entry ->
prospect) and, on `warehouse_drafts`, `prospect_id`, `carried_message_id`, `sent_at` (backfilled
from the audit log). The migration creates no prospect.

An entry is an interlocutor or the owner; identical names (accents, case, order and civility aside)
of one site are one person. Each card line shows the person's state and actions, with or without
any backfill:

| State | Meaning | Action |
| --- | --- | --- |
| linked | the prospect: block (« Ne pas contacter », departed, archived, excluded), commercial state, « Semaine de contact », e-mails sent, next scheduled send, warehouse mail pending | « Contacter » (Contact workbench), « Fiche » |
| « Fiche trouvée » | exactly one record: same name **and** same address or company | « Contacter » → attach, then Contact |
| « À rattacher » | any other look-alike (same address under another name, homonym elsewhere, same family name and initial in the company, several records) | « Contacter » → a person chooses, or says it is someone else |
| « Pas encore prospect » | nobody alike | « Contacter » → confirm first / last name and company, create |
| « Nom incomplet » | one word only | the person completes it in the same dialog |
| « Sans nom de personne » | mailbox, team, company, several names | not contactable: name a person with « Modifier » |

- **No person, no prospect.** A message is addressed to a person; none is invented from
  « Service expédition » or a company name. A generic address (`contact@`) of a named person is
  fine.
- **Creation** needs a company, prefilled with the warehouse's owning company (see *Owning
  company*). It copies the function, the addresses (primary only when there is
  exactly one; all unverified) and records the provenance. It is refused while the same person is
  in the base (`person_exists`), or when the address is that of someone under « Ne pas contacter »;
  other look-alikes need the explicit « autre personne » (`person_to_confirm`).
- **Linking** never changes an opposition or a hold. An existing record only receives the listing's
  addresses when it has none. A blocked person's programmed warehouse mails stop (`failed`).
- Not covered: undoing a link (it disappears only with the prospect); renaming a listing entry
  shows it unlinked again (the same record is then proposed).

Creating and linking people and attaching companies take one transaction-level lock
(`warehouse_people.serialize`) and compare under it, so simultaneous requests never create a person
or a company twice.

### Owning company

Owner: `services/warehouse_companies.py`. Most imported warehouses have no company. VIPER only
**proposes**; a person confirms.

| Proposal | When |
| --- | --- |
| existing company | exactly one company found by the domain of the listing's addresses (its own domain or its prospects'; never a webmail), the written owner, or the company part of the warehouse name |
| new company | nothing found or alike, and the name holds one company part (`naming.organisations`) that is not a site or street label |
| none (« à choisir ») | several companies in the name, several companies found, only a close spelling, or nothing to go on; the look-alikes are listed |

- On « Contacter » of a companyless warehouse, the dialog asks for the company first (prefilled,
  editable: existing or new). Confirming attaches the warehouse, so its other people are not asked
  again; the same-person comparison then runs with that company.
- « Sociétés à rattacher (n) » (`/prospection/warehouse-companies`) lists every companyless
  warehouse with people: one line each with the proposal and its source, editable; only the lines a
  person checks are attached, one by one (a failed line says why, the others pass).
- Attaching (`POST /api/warehouses/{id}/company`, a signed-in person) links the matching building of
  the company or adds one with the warehouse's address (kind « Entrepôt »). A new name equal to one
  existing company uses it (several: `company_ambiguous`); a warehouse already attached elsewhere
  (`already_attached`) or a SIRET held by another company (`siret_other_company`) is refused.
- The directory shows the owning company on each card.
- The backfill's dry run lists the proposals; the command attaches none.

### Backfill

From `backend/`; in production inside the API container, as for `backfill-warehouses`:

    python -m app.cli warehouse-people            # dry run: lists every person, writes nothing
    python -m app.cli warehouse-people --apply

`À RATTACHER` (unambiguous match) is linked; `À CRÉER` (nobody alike, full name, warehouse with an
owning company) is created. `À TRANCHER`, `SANS SOCIÉTÉ`, `PROPRIÉTAIRE À VÉRIFIER` (an owner is
never created in bulk: it is often a company), `NOM INCOMPLET` and `PAS UNE PERSONNE` are only
listed, for the warehouse sheet. Review the proposed first / last name split before applying.
Running it again creates nothing new. Warehouses imported from a workbook have no owning company:
confirm them first on « Sociétés à rattacher », then run the command.

## Former warehouse mails

No warehouse mail is written, edited, validated or programmed any more (saving « À contacter » no
longer creates a draft). `warehouse_drafts` is history, listed on « Mails d'entrepôts »
(`/prospection/warehouse-drafts`) and on the person's Contact sheet (« Mails entrepôt »). A draft
never sent keeps its text there, for reading.

What remains possible:

- **Already programmed mails** (approved by a person) are still sent by the dispatch worker, with
  the former checks (sending switch, allowlist, lateness, eligibility, former address, identity
  doubt), and one more: never to a person (linked, or holding the address, whatever the names) who
  already has a Contact send (sent, being sent or « peut-être parti ») or another warehouse mail
  sent or unsettled (`contacted_in_contact`). « Retirer la programmation »
  withdraws one. Changing the warehouse category or the person's function stops it
  (`warehouse_changed`).
- **Unknown sends** (`uncertain`, or `sending` more than 15 minutes after its moment) are settled by
  a person after checking the mailbox: « Il est parti » records the send, « Pas parti » marks it
  `failed`. Nothing is sent again.

### Never twice (`services/warehouse_history.py`)

A warehouse mail is a prospect's when linked to them, or, unlinked, when it went to their own
address (a shared mailbox only under their name) or to a listing entry they are linked to.

- While one is programmed, being sent or unknown, nothing is programmed or leaves from Contact for
  that person (`warehouse_send_pending`, dispatcher `send_warehouse_pending`).
- A **sent** one counts among the three e-mails: once the person is linked and has an open
  « Semaine de contact » (not S0), it is recorded as the first unsent step (the Contact), with its
  subject, text, recipient and send day, source `migration`. Two sends of one day are one step; a
  Contact send recorded the same day or later covers it. Without a week it waits (nothing can be
  prepared meanwhile) and is recorded when a week is chosen or imported. An unsent text of that
  step stays in its versions. A step that is programmed, being sent or « peut-être parti » is never
  written over: the warehouse send waits until a person settles it (unschedule then « Contacter »
  on the warehouse card, « Marquer comme envoyé », or a new « Semaine de contact »). An uncounted send holds Contact sends back
  (`warehouse_send_unrecorded`).
- A later change of week restarts the sequence like for any prospect.

The Contact drafting rules apply to these people: the former per-category DIHNAMO check of
warehouse mails no longer exists.

`services/warehouse_draft_text.py` (the former wording) is only kept because migration `0045`
imports it.

## Workbook import

Authenticated, CSRF-protected endpoints:

- `GET /api/warehouses`, `GET /api/warehouses/counts`, `GET /api/warehouses/{id}`
- `GET /api/warehouses/company-proposals`, `POST /api/warehouses/{id}/company`
- `GET`, `POST /api/warehouses/{id}/people` (read states; attach `prospect_id` or `create`)
- `GET /api/warehouses/drafts[?prospect_id=]`, `GET /api/warehouses/drafts/dispatch-status`,
  `POST /api/warehouses/drafts/{id}/unschedule`, `POST /api/warehouses/drafts/{id}/resolve`
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

A programmed warehouse mail to the address of a person out of prospecting (or to its linked person),
or for the warehouse of an archived or excluded company, becomes `failed` with the reason
([`prospecting-lifecycle.md`](prospecting-lifecycle.md)). A recipient that looks like someone else's
is blocked the same way ([`email-identity.md`](email-identity.md)). A linked person's Contact
messages follow the Contact rules of their own record and company.
