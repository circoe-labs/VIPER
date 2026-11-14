# Company directory in Prospection

The company-type block on `/prospection` includes the actual company directory. The category
buttons show live counts from `GET /api/companies/counts`: `all`, `institutional`, `sme`, `large`
and `unclassified`. The four category totals partition every company ID exactly once. Companies
without prospects or establishments are included; prospect counts never determine membership.

The list starts folded. A category click opens it; it can also be opened/closed independently.
It shares the existing company list API, server pagination (50 rows), company table and editor
with `/prospection/companies`. Search inside this list searches companies, and each company
appears once. Selecting a type retains the existing Prospection type filter on associated people.

Counts follow the full company base. The list's own count follows its selected type/search.
Unclassified companies stay in `À classer`: this view neither guesses a classification nor
creates duplicate company records. Company editor writes refresh the directory and its counts.

## List `sort` contract (Prospection control bar)

One `sort` query param, same values on the three entity lists, so one control bar drives them:

| Endpoint | `sort` values | Default |
| --- | --- | --- |
| `GET /api/companies`, `GET /api/warehouses` (enum `EntitySort`, `repositories/list_sort.py`) | `name`, `created`, `updated` | `name` |
| `GET /api/prospection/prospects` (enum `ProspectSort`) | `name`, `created`, `updated` (+ `company`, `next_due`, `planned_contact`, `verification`, `file`, kept) | `name` |

- `name`: A to Z, case and accents ignored. `created`: date added, newest first. `updated`: last
  change, newest first. Every order ends on the row name then the id, so pages never overlap or skip.
- Unknown value: HTTP 422 (FastAPI validation). Response shapes are unchanged.
- Company `q` covers names, e-mail domain, website, sector (commercial segment and activity
  categories), establishment cities, contact names, or digits of a SIREN/SIRET. Warehouse `q` covers
  name, owner, role, city, postal code, address, SIRET and contacts. Warehouses have no company link
  or searchable category label (the category is a filter).

One-off classification research uses the official French company search API. Cached evidence
and before/after reports stay in ignored `private/company-classification/`. Only reviewed exact
legal-name/acronym matches are applied, preferring matching postcodes; historical establishment
trading names alone are insufficient. Public legal entities use their legal nature; other
entities use the official PME/ETI/GE category (ETI and GE share the existing large-company view).
Missing or ambiguous identity/category evidence leaves a company unclassified. Updates are
attributed to an agent in the audit log and change only `company_kind` and its update timestamp;
manual classifications and records edited since research are preserved.
