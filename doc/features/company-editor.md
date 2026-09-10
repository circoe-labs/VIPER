# Company editor — lightweight company and establishment maintenance (Task 07)

A company is the **documentary context** of prospects: who employs them, its identifiers, how Circoe classifies it
and where its sites are. The Company editor lets the user feed and correct that context without the Database
Explorer. It is deliberately **not a CRM dossier**: no deals, projects, tasks, notes timeline or contact tracking —
those belong to prospects (Task 15) or are out of scope for V1.

Decisions: I-37, I-38, I-39, I-70, I-71 in the decision log. Schema: `companies`, `establishments`,
`company_activity_categories` in [data-model.md](../architecture/data-model.md).

## Entry points

| Where | How |
|---|---|
| **Entreprises** page, `/prospection/companies` | Secondary page of Prospection (the *Prospection* navigation item stays current). Search box (name, legal name, e-mail domain, website, SIREN/SIRET digits), table (*Entreprise* + legal name, SIREN, e-mail domain, primary establishment city, segment, establishment and prospect counts), 50 rows per page with *Précédentes/Suivantes*, *Nouvelle entreprise*. The name opens the editor. |
| Prospection page (`/prospection`) | Until Task 14 builds the people list, its placeholder links to *Gérer les entreprises*. Task 14 keeps a link to the Entreprises page in the Prospection header. |
| Anywhere in the signed-in app | `useCompanyEditor()` (`frontend/src/companies/CompanyEditorProvider.tsx`, mounted by `AppShell`): `openCompanyEditor('new' \| id, { initialName?, onSaved?, onDeleted? })`. Intended for the Prospect editor's company selector (Task 15, inline creation with `initialName`) and global search (Task 17). |
| Database Explorer | Context menu of a `companies` row → *Ouvrir dans l’éditeur* (row section); the grid reloads after a save or a deletion. |

## Fields and semantics

| Section | Field (UI label) | Column | Rules |
|---|---|---|---|
| Identité | Nom de l'entreprise * | `display_name` | Required. Usual name shown everywhere. Stored trimmed, inner spaces collapsed; 255 characters. |
| | Raison sociale | `legal_name` | Optional legal name; 255. |
| | SIREN | `siren` | Optional. Spaces ignored; 9 digits with a valid Luhn check digit. Unique across companies. |
| | Taille | `size_label` | Free text (e.g. `50-249 salariés`); no taxonomy yet (data model). 100. |
| | Site web | `website_url` | Optional. `https://` is added when no scheme is typed; scheme and host lowercased; `http`/`https` only; no user info. |
| | Domaine e-mail | `email_domain` | Domain of the company's professional addresses. `@Exemple.fr`, `jean@exemple.fr` or `https://www.exemple.fr/` are stored as `exemple.fr` (lowercase, no `@`, scheme, path or `www.`). Webmail domains (`gmail.com`, `orange.fr`… — the import's list) are refused: they name no employer and would make every webmail user look like an employee in company matching. The editor suggests the website's host (*Utiliser « exemple.fr »*) while the domain is empty — a suggestion, never filled silently. |
| Classification | Segment commercial | `commercial_segment_id` | At most one (`TaxonomySelect`, inline creation). |
| | Catégories d'activité | `company_activity_categories` | Any number (`TaxonomyMultiSelect`, inline creation). Inactive values stay while selected. |
| Établissements | see below | `establishments` | Company-only: prospects are not linked to an establishment in V1. |
| Contexte Circoe | Projet déjà réalisé avec l'entreprise · Type de projet · Références Circoe · Approche client | `project_done_with_circoe`, `project_type`, `circoe_references`, `client_approach` | Free multi-line texts kept from the legacy workbook columns of the same names; trimmed, 10 000 characters. |
| Prospects associés | (read-only) | — | Count and the first 100 prospects (name, role · exact title, activity, *Ne pas contacter* when blocked), by last then first name. Navigation only: people are edited in the Prospect editor (Task 15). |

Blank texts are stored as NULL.

### Identifiers (SIREN / SIRET)

- Spaces (including no-break spaces) are ignored; the stored value is digits only (ADR-0002 CHECKs).
- **Format** (9 / 14 digits) is always required.
- **Check digit**: Luhn over the 9 or 14 digits; La Poste's establishments (SIREN `356000000`) use their own rule
  (digit sum multiple of 5).
- A value **left unchanged** is not re-checked: an imported or explorer-edited identifier that fails its key never
  blocks an unrelated edit; the editor shows it as a warning (*Le SIREN enregistré ne respecte pas la clé de
  contrôle : vérifiez-le.*). Changing it requires a valid key.
- A SIRET that does not start with the company's SIREN is a **warning**, not a refusal (the data may be right and the
  SIREN wrong, or the reverse).
- Uniqueness: a SIREN held by another company, or a SIRET held by another company's establishment, is refused with the
  name of that company (*Ce SIREN est déjà celui de « … ».*). The same SIRET twice in one form is refused too.

### Establishments

- Repeater of cards: *Nom de l'établissement*, *Type* (free text with suggestions: siège, agence, entrepôt, dépôt,
  plateforme logistique, usine), *SIRET*, *Adresse*, *Complément d'adresse*, *Code postal*, *Ville*, *Pays*, the
  *Établissement principal* radio and *Retirer « … »*.
- **Exactly one primary** establishment when a company has any: the first one added is primary; choosing another
  moves the flag; removing the primary hands it to the first remaining one; when a payload flags none, the server
  makes the first one primary; two flagged primaries are refused. The database keeps at most one
  (`uq_establishments_company_id_primary`); the service writes a switch in two flushes so that index never sees two.
- Establishments are saved **with** the company (one atomic save). The list is the full list: an establishment left
  out is deleted.
- After saving, the primary establishment is listed first.

### Deletion

Only a company **no prospect references** can be deleted (`companies ← prospects` is `ON DELETE RESTRICT`); otherwise
the API answers 409 `in_use` with the count and the editor explains that the prospects must be moved first. Its
establishments are deleted with it, each with its own audit event; category links go with it.

## Similar companies ("does this company already exist?")

While a **new** company is typed, the editor lists existing companies with the same name key (legal forms, case,
accents and punctuation ignored — the import's `company_key`), a close spelling (similarity ≥ 0.85) or the same
e-mail domain, each with *Ouvrir « … »*. It is a warning only; nothing is refused. `GET /api/companies/similar` is the
same helper Task 09 (duplicate company candidates) and Task 15 (inline creation) can call
(`app.services.companies.find_similar`).

## Editor behaviour

- Wide drawer (`Drawer size="xl"`), focus on the name field when it opens, sections *Identité*, *Classification*,
  *Établissements*, *Contexte Circoe*, *Prospects associés*.
- Footer = dirty-state bar: status (*Modifications non enregistrées*, *Entreprise enregistrée.*, *Corrigez les N champs
  signalés.*, *Enregistrement impossible : …*, announced through `role="status"`), *Supprimer* (existing company),
  *Annuler les modifications* (reverts to the saved state) or *Fermer*, and *Enregistrer* (enabled only with changes).
- **Saving keeps the drawer open** on the saved company (a new company becomes an existing one); `onSaved` receives
  it. Closing (Esc, ×, backdrop, *Fermer*) or opening a similar company with unsaved changes asks first
  (*Abandonner les modifications ?* — *Continuer la saisie* / *Fermer sans enregistrer*).
- Keyboard: Enter in a one-line field saves (an open picker uses Enter to choose), **Ctrl+S / ⌘S** saves from anywhere
  in the drawer, Esc closes (guarded), Tab order follows the sections; adding an establishment focuses its name,
  removing one returns focus to *Ajouter un établissement*.
- Validation: a field's error shows once it was left with a value or a save was attempted; the first invalid field gets
  the focus. Server refusals are placed on their field (`detail.field`, e.g. `establishments.1.siret`) and repeated in
  the status bar. All copy is French (`frontend/src/companies/messages.ts`, `companyForm.ts`).

## API — `/api/companies` (session + CSRF, `api_router`)

| Method & path | Body / query | Answer |
|---|---|---|
| `GET /companies` | `q` (≤ 200), `limit` 1–200 (50), `offset` | `{items: [{id, display_name, legal_name, siren, email_domain, commercial_segment_label, city, establishment_count, prospect_count, updated_at}], total}` ordered by name (case/accents ignored) |
| `GET /companies/similar` | `name`, `email_domain`, `exclude` | `[{id, display_name, legal_name, email_domain, reasons: [same_company_name \| similar_company_name \| same_email_domain]}]` (at most 5) |
| `GET /companies/{id}` | — | company + `commercial_segment {id,label,active}`, `activity_categories`, `establishments` (primary first), `prospect_count`, `prospects` (first 100) |
| `POST /companies` | company fields, `commercial_segment_id`, `activity_category_ids`, `establishments` (both lists optional) | 201 company |
| `PUT /companies/{id}` | the **whole** editable state; `activity_category_ids` and `establishments` are required (an omitted field is cleared; an omitted establishment is deleted); an establishment keeps its `id` | company |
| `DELETE /companies/{id}` | — | 204 |

Refusals (`app/api/errors.py`, shared with Settings):

| Status | `detail` | Example |
|---|---|---|
| 422 | `{code: "invalid", field, reason}` — `field` is a path (`siren`, `email_domain`, `establishments.1.siret`, `establishments.0.id`…); `reason` ∈ `blank`, `length`, `format`, `checksum`, `webmail`, `repeated`, `multiple` (two primaries), `unknown` (segment/category/establishment id) | *Ce SIREN n'est pas valide : un chiffre est sans doute erroné (clé de contrôle).* |
| 409 | `{code: "duplicate", field, existing: {id, label, active}}` — `existing` is the company holding the SIREN/SIRET | *Ce SIRET est déjà celui de « Logistique Témoin ».* |
| 409 | `{code: "in_use", usage: {prospects: n}}` | *Suppression impossible : l'entreprise est rattachée à 3 prospects.* |
| 404 | `{code: "not_found"}` | |

## Audit

Every write goes through `CompanyService` with the signed-in actor (`source=ui`). One event per changed row:
`company.created/updated/deleted` (a segment change carries both labels; categories appear as
`activity_categories_ids`, also on creation), `establishment.created/updated/deleted` with the company as subject — so
a company's history (`audit.history(session, "company", id)`, Task 19) includes its establishments. Unchanged rows get
no event; a save that changes nothing writes nothing.

## Code

| Layer | Where |
|---|---|
| Service | `backend/app/services/companies.py` (normalization, identifier rules, `create_company`, `update_company`, `complete_company` — fill-empty enrichment used by the Excel import, Task 09 — `delete_company`, `get_company`, `list_companies`, `find_similar`) |
| Repository | `backend/app/repositories/companies.py` |
| Router | `backend/app/api/routes/companies.py`; refusals `backend/app/api/errors.py` |
| Frontend | `frontend/src/companies/` (`CompaniesPage`, `CompanyEditor`, `CompanyEditorParts`, `EstablishmentsEditor`, `CompanyEditorProvider`, `companyForm.ts`, `messages.ts`, `companies.css`), API hooks `frontend/src/api/companies.ts` |

## Tests

- Backend: `tests/test_companies.py` (normalization of every value, SIREN/SIRET format and key incl. La Poste,
  unchanged imported identifiers, uniqueness naming the holder incl. a race past the pre-check, segment single /
  categories multi with labels in the audit event, establishment create/edit/remove, primary switching in two flushes
  with one event per row, promotion of the first remaining, invalid lists, foreign establishment ids, deletion refused
  with prospects / cascading audited deletion, detail prospects, search by name/legal name/domain/SIREN/SIRET with
  paging, similar companies), `tests/test_companies_api.py` (401 on every route, 403 without/with a forged CSRF token,
  full lifecycle attributed to the signed-in user, PUT requires both lists, 409/422/404 shapes, similar endpoint,
  paging bounds), `tests/test_audit.py` (many-to-many ids on created rows).
- Frontend: `src/companies/companyForm.test.ts` (keys, web values, payload, dirty state, every validation message),
  `CompanyEditor.test.tsx` (creation with validation and normalized payload, identifier warnings vs errors,
  establishment repeater and focus, dirty bar / revert / close guard, Ctrl+S and Enter, server refusals on fields,
  prospects list, delete refused/allowed, domain suggestion, similar companies), `CompaniesPage.test.tsx` (entry from
  Prospection, list cells, search, paging, empty state, refresh after save) — against `src/test/companiesApi.ts`.
- Playwright `e2e/companies.spec.ts` (real backend): Prospection → Entreprises, create a company with two
  establishments, a segment and categories (one created inline), SIRET/SIREN warning, save, find it by SIREN, switch the
  primary establishment and save with Ctrl+S; SIREN checksum and duplicate refusals; deletion refused for a company
  with prospects; dark/light screenshots of the list and the editor at 1440×900; no overflow at 1280 px.
