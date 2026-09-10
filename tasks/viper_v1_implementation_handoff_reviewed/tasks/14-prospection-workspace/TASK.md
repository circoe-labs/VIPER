# Task 14 — Implement Prospection counters, filters and people list

## Goal
Build the daily human workspace for isolating people to verify/contact and moving efficiently through the queue.

## Context
Prospection is explicitly a readable list, not a raw data grid. Counters are actionable filters.

## Coding Skill Requirement
Before editing code, load and follow `/caveman` and `/coding-guideline` from `~/ai/skills/`.

## Scope
### In Scope
- Counters: total, never verified, needs re-check, Active/Unknown/Inactive, contactability blocked, due/to contact, contacted/no-response, responses, appointments as coherent real-data set.
- Counter click filters list.
- Search person/company/email.
- Filters/sort/pagination.
- Readable prospect rows.
- Import/Export/Add buttons.
- Open Prospect editor contract.
- URL/query filter persistence where useful.

### Out of Scope
- No raw Database controls.
- No agent suggestions.
- No full editor implementation here.

## Dependencies
Tasks 02-03, 09-10.

## Implementation Steps
1. Define typed list/filter model.
2. Build aggregate counters from same semantics.
3. Build list/search/filter/sort.
4. Wire import/export/add entrypoints.
5. Add empty/loading/error states.
6. Test filter drill-down.

## Files Likely Touched
Prospection route/components, query service, filters, tests.

## Architecture Constraints
Counters/list use same source-of-truth status semantics. Avoid N+1. Stale threshold remains configurable/unresolved.

## Testing Requirements
Counter→filter, combined filters, search, no-response derivation, contactability filter, pagination/performance, empty states.

## Acceptance Criteria
- User can isolate next records quickly.
- Cards are functional filters.
- List is spacious and human-readable.

## Documentation Updates
Document KPI/filter definitions.

## Handoff Notes
Global visual reference: `../../visuals/neon-command-brand-direction.png`.

## Implementation report

Branch `task-14-prospection` (worktree), based on `claude` @ b214be8, with `claude` merged at 3998d0d (E2E
isolation) and 341bc7f (Task 10 export).

### What was built

- **Canonical semantics** (`backend/app/services/prospection/segments.py`, ADR-0014): 16 segments as SQL predicates
  over one FROM (prospect + company + single tracking + primary e-mail) — `all`, `never_verified`, `needs_recheck`,
  `active` / `unknown` / `inactive`, `do_not_contact`, `email_missing` / `email_invalid` / `email_unverified`,
  `to_contact`, `due`, `contacted`, `no_response`, `responses`, `appointments` — plus the row states
  (`verification_state`, `email_state`, `due`) from the same expressions. Definitions, invariants and rationale:
  `doc/features/prospection-kpis.md` (I-90 … I-94). Home (Task 16) reuses them as they are.
- **ProspectQueryService + API** (`app/services/prospection/query.py`, `app/api/routes/prospection.py`, protected):
  `GET /api/prospection/counters` (one aggregate `count(*) FILTER` query) and `GET /api/prospection/prospects`
  (segment, search on names / company names / any e-mail / phone digits, filters role / activity / referent / stage /
  company / import batch with `none` for role, referent and stage, five stable sorts, offset paging, typed row view
  model). 3 statements per page view whatever the size; no migration (20 000 prospects: ≈ 0.25 s / 0.15 s).
  Optional setting `VIPER_VERIFICATION_STALE_DAYS` (unset by default; the page says no threshold is configured).
- **`/prospection` page** (`frontend/src/prospection/`): header (*Entreprises*, *Importer Excel*, Task 10's
  *Exporter Excel*, *+ Ajouter un prospect* disabled with « Disponible avec l'éditeur de prospect »); 16 toggle
  counter cards in *Base* / *Vérification* / *Suivi de contact*; search + *Filtres* disclosure + sort; one readable
  card per person (identity, role · title, activity and verification badges, company, primary e-mail state, phone,
  stage, *Échu*, planned date + week, response/appointment dates, referent, *Ne pas contacter*) — glyph + text for
  every status; ↑/↓/Home/End/Enter; loading / error / empty-segment / empty-base states; every criterion in the URL.
- **Open-editor contract for Task 15** (`prospectEditor.tsx`, `queue.ts`): `?prospect=<id|new>`,
  `ProspectEditorContext` `{ canCreate, Editor }` receiving `{ target, queue, onNavigate }`; `ProspectQueue.next`
  survives people leaving the segment after a save. Default: open the person's row in the Database Explorer.

### Files

Backend: `app/services/prospection/{__init__,segments,query}.py`, `app/api/routes/prospection.py`, `app/api/router.py`,
`app/core/business_time.py` (moved `BUSINESS_TIMEZONE`; `import_commit.py` and Task 10's export modules import it),
`app/core/config.py`, `app/repositories/taxonomies.py` (`label_key` accepts nullable columns), `.env.example`; tests
`test_prospection.py`, `test_prospection_api.py`, `test_prospection_performance.py`.
Frontend: `src/prospection/*` (page, counters, filters, list, criteria, labels, editor contract, queue, CSS, tests),
`src/api/prospection.ts`, `src/test/prospectionApi.ts`, `src/routes.tsx`, `src/ui/button.css` (link buttons not
underlined, `aria-disabled`), `src/api/companies.ts` (`limit`), `src/test/render.tsx` (`wrap`),
`src/shell/PlaceholderPage.tsx` + `shell.css` (Prospection placeholder removed), `e2e/prospection.spec.ts`,
`e2e/data.ts` (`syntheticWorkbook`, `importProspects`), `e2e/import.spec.ts`, `e2e/companies.spec.ts` and two
component tests (entry link renamed *Entreprises*).
Docs: `doc/features/prospection-kpis.md` (new), ADR-0014, decision log I-90 … I-98, interface-spec, company-editor,
excel-import-export, data-model, overview, design-system, testing-strategy, runbook, open-questions #9.

### Tests run

`python scripts/verify.py --e2e` with `VIPER_E2E_DATABASE_URL=…/viper_wt3_e2e`, `VIPER_E2E_WEB_PORT=5188`,
`VIPER_E2E_API_PORT=8148`, after merging `claude` @ 341bc7f: privacy guard OK, ruff check/format OK, mypy OK
(167 files), **pytest 813 passed, 2 skipped** (private workbook smokes), eslint + tsc OK, **vitest 503 passed**
(37 files), vite build OK, **Playwright 58 passed**.

New tests: backend 58 (`test_prospection.py` 50 — expected members of every segment on one synthetic person per edge
case, stale threshold and boundary, business-day rollover, row states and view model, week in business time, 14
search cases, combined filters incl. `none`, counters == list totals on 3 seeded random bases × 2 contexts × 3 filter
sets, paging stable for every sort, sort orders, 2 statements per page / 1 for the counters for 3 and 60 rows;
`test_prospection_api.py` 7 — 401 on both endpoints, counters == totals over HTTP, contract, validation, stale
setting, read-only; `test_prospection_performance.py` 1 — 20 000 prospects); frontend 21 (`criteria.test.ts` 5,
`queue.test.ts` 6, `ProspectionPage.test.tsx` 10); Playwright 6 (`prospection.spec.ts`: imported own people, every
counter, three counter clicks, reload, filter, keyboard open in the explorer and Back; entry points; screenshots
dark/light at 1440×900 and 1280×800 without horizontal overflow — reviewed, copied to the session scratchpad
`task14-screenshots/`).

### Deviations / decisions

- I-90 … I-98 (definitions in `doc/features/prospection-kpis.md`), ADR-0014. Choices the brief left open:
  `to_contact` includes people **without tracking**; *actionable* queues (`to_contact`, `due`, `no_response`) exclude
  opposed **and inactive** people; `needs_recheck` needs a verified employment and is disjoint from
  `never_verified` (a company change puts the person back in `never_verified`); an appointment date counts as a
  response; `unknown` e-mail status counts as unverified.
- The counters are grouped *Base* / *Vérification* (the brief's verification counters plus the three primary-e-mail
  segments) / *Suivi de contact*; *Activité inconnue* reads *Inconnus* on its card.
- No migration or index (measured); the company filter lists the first 200 companies (API maximum).
- Shared code touched: `BUSINESS_TIMEZONE` moved to `app/core/business_time.py` (import and Task 10 export updated),
  `.btn` links no longer underlined (visible on every header that renders a link as a button), `aria-disabled`
  button style, `PlaceholderPage` loses its `action` prop, `renderApp` `wrap` option, `useCompanies` `limit`,
  `import.spec.ts` uses the shared `syntheticWorkbook`.

### Open points / risks

- Task 15 must mount its editor through `ProspectEditorContext` (contract in `prospection-kpis.md`) and invalidate
  `prospectionKeys.all` after writes; closing with `onNavigate(null)` replaces the history entry (Back then returns
  to the same list, not to the editor).
- Task 16 should import `segments.py` / `count_segments` and link cards with `prospectionHref({ segment })`.
- The stale threshold stays unset until product chooses N (open question #9).
- *Exporter Excel* exports the whole base (Task 10); a filtered export would reuse `ProspectFilters` later.
- Search uses `label_key(concat_ws(...))` per row (no trigram index): fine at V1 scale, Task 17 owns search indexes.
- One pre-existing flake seen once before the merge in a parallel Vitest run (two `CompanyEditor.test.tsx` cases
  hit the 5 s timeout under load, green alone and in the final run).
