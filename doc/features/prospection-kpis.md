# Prospection — segments, counters, filters and the people list (Task 14)

Prospection (`/prospection`) is the daily manual-work page: isolate the next people to verify or contact, open them,
move on. Its counters are filters over **one canonical set of segment definitions** that Home (Task 16) reuses
verbatim — never re-derive "due" or "no response" elsewhere.

Decisions: I-90 … I-98 in the decision log, [ADR-0014](../adr/0014-canonical-prospect-segments.md). Schema:
[data-model.md](../architecture/data-model.md) (verification contract, contactability, tracking statuses).

## Segment definitions

Source of truth: `backend/app/services/prospection/segments.py` (`Segment`, `predicate(segment, context)`). Every
predicate reads one row per prospect: the prospect, its company, its single contact tracking (V1: one current row)
and its primary e-mail (at most one, always active). Terms used below:

- **business day** — today's date in Europe/Paris (`app/core/business_time.py`), also used for planned-contact weeks;
- **actionable** — `contactability_status = contactable` **and** `activity_status ≠ inactive`: someone to contact or
  follow up now. A do-not-contact prospect is never actionable (durable opposition), nor someone known to have left
  the role (still visible under *Inactifs*);
- **contacted** — the tracking exists and its stage is past `to_contact`, or it has a response or an appointment date;
- **reset channel** — an **active** e-mail or phone whose status is `unverified` while it keeps a `last_verified_at`:
  the trace a company change leaves (I-13: verified active channels go back to `unverified`, keeping the date).

| Key (`?segment=`) | Counter | Definition |
|---|---|---|
| `all` | Tous | Every prospect (do-not-contact included). |
| `active` / `unknown` / `inactive` | Actifs / Inconnus / Inactifs | `activity_status` equals the value. |
| `do_not_contact` | Opposition | `contactability_status = do_not_contact`. |
| `never_verified` | Jamais vérifiés | `employment_verified_at IS NULL` — the current employment context (company, role, title, activity) was never verified. A company change clears the date, so a moved prospect is back here: its *current* context was never verified. |
| `needs_recheck` | À revérifier | Employment verified (`employment_verified_at IS NOT NULL`) **and** either a reset channel exists, or — only when `VIPER_VERIFICATION_STALE_DAYS = N` is set — the verification is older than the start of the business day N days ago. Disjoint from `never_verified`. Unset by default (open question #9): the page then says no age threshold is configured. |
| `email_missing` | E-mail manquant | No primary e-mail (a person with only non-primary or former addresses counts as missing). |
| `email_invalid` | E-mail invalide | Primary e-mail `verification_status = invalid`. |
| `email_unverified` | E-mail non vérifié | Primary e-mail `unverified` **or** `unknown` (not known to be deliverable). |
| `to_contact` | À contacter | Actionable and **not contacted** — a tracking at `to_contact` without response/appointment date, **or no tracking at all** (the untouched base is left to contact). |
| `due` | Échus | `to_contact` and `planned_contact_at` before the start of tomorrow (business day): planned today or earlier. |
| `contacted` | Contactés | Contacted (see above), do-not-contact included — a historical fact. |
| `no_response` | Sans réponse | Actionable, stage `contacted`, `follow_up_1` or `follow_up_2`, and neither a response nor an appointment date: the follow-up queue. |
| `responses` | Réponses | A response date, an appointment date, or a stage reached only after an answer: `response_received`, `appointment_obtained`, `quote_sent`, `quote_follow_up`, `won`, `not_interested` (a negative answer is an answer). |
| `appointments` | Rendez-vous | An appointment date, or stage `appointment_obtained`, `quote_sent`, `quote_follow_up` or `won`. |

**Home (Task 16)** shows these same counts (`count_segments` without criteria), each card linking to
`/prospection?segment=<key>`; its own additions — current commercial stages, monthly progress from the status history,
next actions — are defined in [home-dashboard.md](home-dashboard.md) on top of these predicates (`actionable`,
`responded`, `has_appointment`, `CONTACTED_STAGES`, `APPOINTMENT_STAGES`).

Invariants (tested): `appointments ⊆ responses ⊆ contacted`; `due ⊆ to_contact`; `to_contact` and `contacted` never
overlap; a do-not-contact person is never in `to_contact`, `due` or `no_response`; `never_verified` and
`needs_recheck` never overlap. Outcome segments (`contacted`, `responses`, `appointments`) keep opposed and inactive
people: they count what happened, not what to do.

Row states come from the same predicates (never recomputed in the browser): `verification_state` = `never_verified`
→ `stale` → `channels_reset` → `verified` (first match); `email_state` = `missing` / `invalid` / `verified` /
`unverified`; `due` = the `due` predicate.

## API — `/api/prospection` (session required, GET only)

Both endpoints take the same **criteria**, so a counter always equals the total of the list opened with its segment:

| Parameter | Meaning |
|---|---|
| `q` (≤ 200) | Every word in the person's first/last name or the company's display/legal name (case, accents and spacing ignored, `label_key`), **or** in one of their e-mail addresses (any, former ones included); a number-like query with ≥ 4 digits also matches a phone number (`06 12 34…` finds `+33612 34…`). Role and exact title are not searched. |
| `role` | Role id, or `none` (no role). |
| `activity` | `active`, `unknown`, `inactive`. |
| `referent` | Referent id of the tracking, or `none`. |
| `tracking_status` | A stage, or `none` (no tracking). |
| `company` | Company id. |
| `import_batch` | Import batch id (a prospect source of that batch). |

- `GET /api/prospection/counters` → `{counts: {<segment>: n}, today, stale_threshold_days}` — **one** aggregate query
  (`count(*) FILTER (WHERE …)` per segment).
- `GET /api/prospection/prospects` + `segment` (default `all`), `sort` (`name` — last then first name, accents
  ignored; `company`; `planned_contact` — soonest first, none last; `verification` — never verified first, then
  oldest; `updated` — latest change first; every order ends with the id, so pages never overlap), `limit` 1–200 (50),
  `offset` → `{items, total, limit, offset}`. **Two** queries per page (rows with every joined label, then the total),
  whatever the page size. Each item: `id`, `civility`, names, `role_label`, `exact_job_title`, `company_id`,
  `company_name`, `activity_status`, `employment_verified_at`, `verification_state`, `primary_email`,
  `primary_email_status`, `email_state`, `primary_phone`, `primary_phone_type`, `tracking_status`,
  `planned_contact_at`, `due`, `planned_contact_week` (ISO `2026-W38`, business time), `response_received_at`,
  `appointment_at`, `referent_id`, `referent_name`, `contactability_status`, `do_not_contact_at`, `updated_at`.

No index was added: on 20 000 synthetic prospects the counters answer in ≈ 0.25 s and a deep page in ≈ 0.15 s
locally (`tests/test_prospection_performance.py`, budget 2 s). The `q` search keeps its `label_key`/`strpos`
semantics; the trigram indexes of Task 17 serve the global search ([global-search.md](global-search.md)), not this
criterion.

## Page

- **Header** — *Prospection*, a lead sentence, then *Entreprises* (→ `/prospection/companies`), *Importer Excel*
  (→ `/prospection/import`), *Exporter Excel* (Task 10's `ExportWorkbookButton`: the whole database
  as the normalized workbook, `GET /api/exports/workbook` — not filtered by the page's criteria) and *+ Ajouter un prospect* (see the editor contract).
- **Counters** — three labelled groups of toggle cards: *Base* (Tous, Actifs, Inconnus, Inactifs, Opposition),
  *Vérification* (Jamais vérifiés, À revérifier, E-mail manquant / invalide / non vérifié, plus the stale-threshold
  note), *Suivi de contact* (À contacter, Échus, Contactés, Sans réponse, Réponses, Rendez-vous). A click shows that
  segment at once; the active card has `aria-pressed="true"`, a check mark and a stronger outline (never colour alone).
  Counts follow the search and filters. Each card's tooltip is its definition in one sentence, repeated under the list
  title.
- **Toolbar** — search (debounced), *Filtres* (disclosure with the number of active filters; open on load when one is
  set): Rôle, Activité, Suivi de contact, Référent, Entreprise (picker over the first 200 companies), Import (committed
  imports of the history); *Trier par*. *Réinitialiser* clears the segment, search and filters (keeps the sort).
- **People list** — one card per person, 50 per page (*Précédents / Suivants*): initials, civility and name (the
  card's link), *Ne pas contacter* badge and a red edge when opposed, role · exact title (or *Rôle non renseigné*),
  activity and employment-verification badges (*Emploi jamais vérifié*, *Coordonnées à revérifier*, *Vérifié le … ·
  ancien* in warning style with an icon; *Vérifié le …* in success style); company, primary e-mail with its state
  (*Invalide*, *Non vérifié*, *Vérifié*, or *Pas d'e-mail principal*) and primary phone; tracking stage (*Échu* badge
  when due), *Prévu le … S38*, response and appointment dates, *Référent : …*. Every status is glyph + text.
  Keyboard: Tab reaches each person, ↑/↓/Home/End move between people, Enter opens. Three columns at 1280–1920 px,
  two then one in narrower workspaces.
- **States** — loading (*Chargement des prospects…*), errors with *Réessayer* (list and counters separately), empty
  segment or no match, and an empty base (no prospect, no criteria) that invites to *Importer Excel*.

## URL contract

`/prospection?segment=due&q=…&role=…&activity=…&referent=…&tracking_status=…&company=…&import_batch=…&sort=…&page=2&prospect=…`
— API parameter names, defaults omitted (`frontend/src/prospection/criteria.ts`; malformed values fall back to their
default). Criteria changes **replace** the history entry (Back leaves the page; returning restores it as it was);
opening a prospect **pushes** one. Other pages link in with `prospectionHref({ segment: 'due' })` (Home's cards).

## Open-editor contract (for Task 15)

`frontend/src/prospection/prospectEditor.tsx`:

- Opening a person sets `?prospect=<id>` (pushed, so Back closes the editor); *+ Ajouter un prospect* sets
  `?prospect=new`. While the parameter is set the page renders the implementation's `Editor` with
  `{ target, queue, onNavigate }`, keeping every other parameter so the list stays behind it.
- `queue: ProspectQueue` (`queue.ts`) is the list order when the editor opened: `ids` of the current page, `page`,
  `total`, `criteria`, `position(id)` (1-based rank in the whole list) and `await next(id)` → `{ id, page }` or null at
  the end. After the page's last person, `next` reads the current page again (same criteria, fresh) before the
  following one and returns the first person not already on the queue's page — so a saved person leaving the segment
  (a verified one leaves *Jamais vérifiés*) never makes Save & Next skip anyone.
- `onNavigate(id, { page })` replaces the open prospect (Save & Next); `onNavigate(null)` closes the editor.
- After a write, invalidate `prospectionKeys.all` (`frontend/src/api/prospection.ts`): counters and pages refresh.
- Task 15 mounts `<ProspectEditorContext.Provider value={{ canCreate: true, Editor }}>` (e.g. in `AppShell`, beside
  `CompanyEditorProvider`). Until then the default (`EXPLORER_FALLBACK`) is honest: opening a person **replaces** the
  `?prospect=` entry with their row in the Database Explorer (`/database/prospects?filters=[id = …]`), so Back returns
  to the list as it was; *+ Ajouter un prospect* is `aria-disabled` with the tooltip and description « Disponible avec
  l'éditeur de prospect ».

## Code and tests

| Layer | Where |
|---|---|
| Semantics | `backend/app/services/prospection/segments.py` |
| Query service | `backend/app/services/prospection/query.py` (`count_segments`, `list_prospects`, filters, sorts, row view model) |
| Router | `backend/app/api/routes/prospection.py`; setting `VIPER_VERIFICATION_STALE_DAYS` (`app/core/config.py`) |
| Frontend | `frontend/src/prospection/` (`ProspectionPage`, `CounterCards`, `ProspectionFilters`, `ProspectList`, `criteria.ts`, `labels.ts`, `prospectEditor.tsx`, `queue.ts`, `prospection.css`; *Exporter Excel* is `src/exports/ExportWorkbookButton.tsx`), API hooks `frontend/src/api/prospection.ts` |

- Backend: `tests/test_prospection.py` (one synthetic person per edge case and the expected members of every segment:
  DNC excluded from due/to contact/no response, no tracking, planned tomorrow at midnight, no primary e-mail,
  secondary only, invalid/unknown e-mail, verification null vs set, company change then re-verification, stale
  threshold and its boundary, business-day rollover; row states and view model; search across names, company, any
  e-mail and phone formats with literal wildcards; every filter and `none`, combined with segments; counters == list
  totals for every segment on seeded random bases; paging stable for every sort; 2 statements per page and 1 for the
  counters whatever the row count), `tests/test_prospection_api.py` (401, counters == totals through HTTP, contract,
  `none` and 422 validation, stale setting, read-only), `tests/test_prospection_performance.py`.
- Frontend: `criteria.test.ts`, `queue.test.ts` (page walk, next page, people leaving the segment, end),
  `ProspectionPage.test.tsx` (entry points, counter click → URL + list, search and reset, URL restore and page reset,
  row states as text + glyph, keyboard and explorer fallback, editor contract with a custom implementation and Save &
  Next, empty base, errors) against `src/test/prospectionApi.ts`.
- Playwright `e2e/prospection.spec.ts`: imports its own synthetic people through the import API (`importProspects` in
  `e2e/data.ts`), searches their unique tag, checks every counter, clicks *Échus* / *Sans réponse* / *Rendez-vous*,
  reload, a filter, keyboard open in the explorer and Back; screenshots dark/light at 1440×900 and 1280×800 with no
  horizontal overflow.
