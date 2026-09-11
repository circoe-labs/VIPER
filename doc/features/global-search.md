# Global search (Task 17)

One compact field in the shell header finds a prospect, a company or an establishment from any page and opens it
where it is edited. It is a lookup, not a search platform: no external search, no saved searches, no full-text over
notes. Decisions: I-120 … I-129 in the decision log, [ADR-0017](../adr/0017-global-search-trigram-indexes.md)
(indexes and measurements).

## What is searched

| Result | Fields (how they compare) | Shown |
|---|---|---|
| **Prospect** | first + last name (folded, words in any order); **any** of their e-mail addresses, former ones included (lowercase); any phone number (digits) | name; role · exact title; company; the matched e-mail or phone; badges *Ne pas contacter*, *Inactif* |
| **Company** | display name, legal name (folded); SIREN (digits); e-mail domain; website host (lowercase) | display name; legal name when it differs; SIREN; domain; city of the primary establishment; prospect count; the matched website |
| **Establishment** | SIRET (digits); establishment name, city (folded) | name (else kind, city or SIRET); company; SIRET; address; badge *Principal* |

Rules:

- **Folded** = `search_key` (migration 0007): accents removed, lowercase — `élodie`, `ELODIE` and `Élo` find *Élodie*.
- The query is split into words; **every word must match** the same field. A word of **3 characters or more** matches
  anywhere in the value; a **shorter word only at the start of a word** (value start, or after a space, a hyphen or an
  apostrophe): `ma` finds *Martin* and *Saint-Mars*, not *Thomas*.
- **Numbers**: a query made of digits, spaces, dots and dashes with ≥ 3 digits is compared with SIREN and SIRET
  digits; with ≥ 4 digits it is also a phone number, its national leading 0 dropped (`06 12 34` finds `+3361234…`).
  A 14-digit SIRET also finds its company (its first nine digits are the SIREN).
- **Addresses and hosts**: a one-word query is compared with e-mail addresses as typed and with domains/websites as a
  host — `jean@exemple.fr`, `https://www.exemple.fr/contact` and `exemple.fr` all find the company whose domain or
  website is `exemple.fr`.
- `%`, `_` and `\` are matched literally; the query travels as a bound parameter (never concatenated into SQL).
- Role and exact title, notes, Circoe context texts and prospects' company names are **not** searched (a company
  query lists the company, not every employee; Prospection's search box does combine people and companies).

## Ranking and limits

- Each result says how it matched: **exact** — the whole value is the query (a name in any word order, an e-mail, a
  phone number including its `+33…` forms, a SIREN, a SIRET, a domain, a website host, a city); **prefix** — every word
  starts a word of the value, or the value starts with the typed identifier; **contains** — anywhere.
- A row matching through several fields keeps its best match (then the field listed first in the table above).
- Within a group: exact, then prefix, then contains; then by name (prospects: last then first name; companies:
  name; establishments: company, primary first, name), then id — stable.
- **5 results per group**; a group with more says *Premiers résultats · précisez la recherche*.
- **Groups** appear only when they have results, the group whose first result matched best first (ties: Prospects,
  Entreprises, Établissements) — a SIREN puts *Entreprises* on top, a name *Prospects*.
- The query needs **2 to 200 characters** (spaces collapsed); below 2 the field asks for more and sends nothing.

## Using it

| Action | Keyboard / pointer |
|---|---|
| Focus the search from anywhere | **Ctrl+K** (⌘K), or **/** when not typing in a field; ignored while a dialog (editor, confirmation) is open |
| Search | type; the request leaves 200 ms after the last keystroke |
| Move between results | **↑ / ↓** (all groups, wrapping); pointer hover |
| Open | **Enter** or click: a prospect opens `/prospection?prospect=<id>` (the Prospect editor contract, [prospection-kpis.md](prospection-kpis.md#open-editor-contract-for-task-15)); a company opens the Company editor (`useCompanyEditor`); an establishment opens its company |
| Open the row in the Database Explorer | **Shift+Enter**, or the table button of the active/hovered result — `/database/<table>?filters=[id = …]` |
| Close / clear | **Esc** closes the results, a second **Esc** clears the field; **Tab** closes and moves on |

Opening a result closes the popup and clears the field; closing the Company editor returns the focus to the search.

States: *Saisissez au moins 2 caractères.*, *Recherche…* (spinner, also in the field while a request runs), *Aucun
résultat pour « … ».*, *La recherche a échoué.* with *Réessayer*. While a newer query is pending the previous
results stay visible, dimmed and inert (Enter does nothing until the current answer arrives). A polite live region
announces the result count.

**Stale answers never win**: each query is its own TanStack Query entry, a newer query cancels the older request
(AbortSignal) and an answer arriving late is stored for its own query only — the list always shows the answer to
what is typed.

Accessibility: WAI-ARIA combobox (`aria-expanded`, `aria-controls`, `aria-activedescendant`, `aria-keyshortcuts`)
with a listbox of named groups (*Prospects*, *Entreprises*, *Établissements*) of options; the focus stays in the
field; every status is glyph + text.

## API — `GET /api/search?q=` (session required, read-only)

`200 {query, groups: [{type, items, has_more}]}`; `422 {detail: {code: "invalid", field: "q", reason: "length"}}`
for a query outside 2–200 characters (FastAPI's 422 without `q`); 401 without a session. Every item:

| Field | Meaning |
|---|---|
| `type` | `prospect` \| `company` \| `establishment` |
| `id`, `label`, `sublabel` | the record and two display texts (see *What is searched*) |
| `match` | `{field: name \| legal_name \| email \| phone \| siren \| email_domain \| website \| siret \| city, kind: exact \| prefix \| contains, value}` — `value` is the matched value when the label does not show it |
| `badges` | `do_not_contact`, `inactive` (prospects), `primary` (establishments) |
| `open` | `{editor: prospect \| company, id}` — the editor to open (an establishment opens its company) |
| `record` | `{table: prospects \| companies \| establishments, id}` — the Database Explorer row |
| prospect | `company_id`, `company_name` |
| company | `siren`, `email_domain`, `city` (primary establishment), `prospect_count` |
| establishment | `company_id`, `company_name`, `siret` |

Never raw rows: no e-mail list, no personal field beyond the matched value.

## Indexed fields and cost

Migration 0007 (ADR-0017): `pg_trgm` GIN indexes on `person_search_key(first_name, last_name)`, `emails.address`,
`phones.number`, `search_key(companies.display_name)`, `search_key(companies.legal_name)`,
`search_key(establishments.name)`, `search_key(establishments.city)`. SIREN, SIRET, domains and websites are read
from the small company/establishment tables. A search is **three statements** (one per group) whatever the base size;
on 20 000 synthetic prospects p95 ≈ 40 ms in the service, ≈ 55 ms through HTTP (budget 150 ms). The hosting
database must allow the `pg_trgm` extension (like `unaccent`).

## Code and tests

| Layer | Where |
|---|---|
| Service | `backend/app/services/search.py` (`read_terms`, per-group candidate statements, ranking, `search`) |
| Router | `backend/app/api/routes/search.py` |
| Migration / ORM indexes | `backend/migrations/versions/0007_search_indexes.py`, `app/models/common.py` (`trigram_index`) |
| Frontend | `frontend/src/shell/GlobalSearch.tsx` + `global-search.css` (in `AppShell`'s header), `frontend/src/api/search.ts`, `recordHref` in `src/database/explorerView.ts` |

- Backend: `tests/test_search.py` (names with accents/case/order, 2-letter word starts, ranking exact → prefix →
  contains, any e-mail incl. former, phone formats, badges and targets, legal name, SIREN/SIRET digits and the SIREN of
  a SIRET, domain from an e-mail, website host, establishments by SIRET/city and label fallback, group order and
  limit, 3 statements, length refusal, wildcards and quotes literal), `tests/test_search_api.py` (401, 422, typed
  contract, no write), `tests/test_search_performance.py` (20 000 prospects locally, p95 < 150 ms; `CI` set: 2 000
  and 500 ms — shared runners are slower and the suite stays fast).
- Frontend: `src/shell/GlobalSearch.test.tsx` (one request after typing, grouped typed results, a late answer to an
  earlier query never shown and its request aborted, arrows/Enter/Shift+Enter, mouse, Ctrl+K and `/`, Esc/Tab,
  2-character hint, no result, error and retry) against `src/test/searchApi.ts`.
- Playwright `e2e/search.spec.ts`: each test creates its own company, establishments (API) and prospects (import API)
  with a unique tag; Ctrl+K and `/`, grouped results asserted on its own rows only, a company opens its editor, a
  prospect opens `?prospect=<id>`, phone/SIREN/SIRET searches, Shift+Enter to the explorer row; screenshots dark and
  light at 1440×900 of the open results (`global-search-*.png`).
