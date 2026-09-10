# Task 07 — Implement lightweight Company and Establishment editor

## Goal
Allow manual creation/update of the company context the user explicitly wants to feed outside raw Database editing.

## Context
Company is documentary context, not a CRM dossier. Prospect editor should link to this dedicated lightweight company editor.

## Coding Skill Requirement
Before editing code, load and follow `/caveman` and `/coding-guideline` from `~/ai/skills/`.

## Scope
### In Scope
- Create/edit company name/legal name/SIREN/site/domain/size.
- One commercial segment, multiple categories.
- Manage establishments with SIRET/address/kind/primary.
- Edit project/reference/approach metadata.
- Show associated prospect count/list for navigation.
- Audit changes.

### Out of Scope
- No opportunities/projects/deals/tasks.
- No prospect contact tracking here.

## Dependencies
Tasks 03, 05, 06.

## Implementation Steps
1. Define form/view model.
2. Implement create/edit services.
3. Build company drawer/page.
4. Add establishment repeater/editor.
5. Add taxonomy selectors.
6. Add associated-prospect navigation.
7. Audit/test.

## Files Likely Touched
Company/establishment UI, services, validation, tests.

## Architecture Constraints
No duplicated company fields on Prospect. SIREN/SIRET uniqueness errors are understandable. Company domain normalized.

## Testing Requirements
Create/edit, category multi-select, segment single, establishment CRUD, SIREN/SIRET conflict, audit, keyboard form behavior.

## Acceptance Criteria
- Company table can be fed manually without Database Explorer.
- Establishments remain company-only.
- Editor stays lightweight.

## Documentation Updates
Document company field semantics.

## Handoff Notes
Accessible from Prospect editor/global search later.

## Implementation report

**Status:** done (branch `claude`, commit `feat(task-07): …`). Feature page: `doc/features/company-editor.md`.
Decisions I-37, I-38, I-39, I-70, I-71 (`doc/product/decision-log.md`). No ADR (no significant new technical
choice; the save contract is recorded in I-39).

### What was built

- **CompanyService** (`backend/app/services/companies.py`, repository `app/repositories/companies.py`): create /
  update (whole state, establishments as a full list) / delete (refused while prospects reference the company;
  establishments deleted first, each audited) / detail (segment, categories, establishments primary first, prospect
  count + first 100 prospects with role label) / list+search (every word in names, domain, website, case/accents
  ignored; digits match SIREN or an establishment SIRET; paging, prospect/establishment counts, primary city) /
  `find_similar` (import `company_key` + similarity 0.85 + same e-mail domain). Normalization: trimmed texts, SIREN /
  SIRET spaces removed, 9/14 digits + Luhn (La Poste SIRET digit-sum rule), unchanged stored identifiers not
  re-checked, website `https://` default, e-mail domain lowercase without `@`/scheme/path/`www.`, webmail refused.
  Exactly one primary establishment (none flagged → first); primary switches written in two flushes (the partial
  unique index is not deferrable) with one audit event per row. SIREN/SIRET conflicts → `DuplicateValueError` naming
  the holding company, also when a unique violation races past the pre-check. Services flush, the request commits;
  every row annotated with the server-side actor.
- **API** `/api/companies` (`app/api/routes/companies.py`, protected `api_router`): `GET` list, `GET /similar`,
  `GET /{id}`, `POST`, `PUT` (both lists required), `DELETE`. Refusal translation moved from the Settings router to
  `app/api/errors.py` (shared; 422 now carries an optional `reason`).
- **Audit**: `snapshot()` now records loaded many-to-many collections on created/deleted rows, so `company.created`
  lists `activity_categories_ids`; segment changes carry before/after labels.
- **Frontend**: `src/companies/` — `CompanyEditor` (xl drawer: Identité, Classification with `TaxonomySelect` /
  `TaxonomyMultiSelect` incl. inline creation, Établissements repeater, Contexte Circoe, Prospects associés; dirty-state
  footer, save keeps the drawer open, Enter / Ctrl+S save, close guard, delete-if-safe, similar-companies notice,
  domain suggestion from the website, French validation with warnings vs errors, server refusals on their field),
  `EstablishmentsEditor`, `CompanyEditorParts`, `CompanyEditorProvider` + `useCompanyEditor()` (mounted in `AppShell`
  for Tasks 15/17), `CompaniesPage` at `/prospection/companies` (search, table, paging, empty state), `companyForm.ts`
  (form model, payload, dirty check, validation), `messages.ts`; API hooks `src/api/companies.ts`. Prospection
  placeholder links to *Gérer les entreprises*.
- **Shared UI**: dialog layer bounded by the viewport (a tall Drawer used to grow past the screen — fixed in
  `ui/dialog.css`), `FieldFrame`/`TextField` `warning` prop, `SearchField` primitive (Settings toolbar now uses it),
  `BuildingIcon`, contrast test pairs `warning-fg`/`success-fg` on `surface-raised`.
- **E2E infrastructure**: `playwright.config.ts` runs `companies.spec.ts` in a `company-writes` project that depends
  on the main one, because `database.spec.ts` asserts the synthetic dataset's company counts (36) and the specs share
  one database.

### Files

Backend: `app/services/companies.py`, `app/repositories/companies.py`, `app/api/routes/companies.py`,
`app/api/errors.py` (new); `app/api/router.py`, `app/api/routes/settings.py`, `app/services/errors.py`,
`app/services/audit_changes.py`; tests `tests/test_companies.py`, `tests/test_companies_api.py` (new),
`tests/builders.py` (Luhn helpers, synthetic SIREN/SIRET), `tests/test_audit.py`.
Frontend: `src/companies/*` (new), `src/api/companies.ts`, `src/test/companiesApi.ts`, `src/ui/SearchField.tsx`,
`src/ui/search-field.css` (new); `src/api/settings.ts`, `src/routes.tsx`, `src/shell/AppShell.tsx`,
`src/shell/PlaceholderPage.tsx`, `src/settings/shared.tsx`, `src/settings/settings.css`, `src/ui/fields.tsx`,
`src/ui/fields.css`, `src/ui/fields.test.tsx`, `src/ui/dialog.css`, `src/ui/icons.tsx`, `src/theme/tokens.test.ts`,
`e2e/companies.spec.ts` (new), `playwright.config.ts`.
Docs: `doc/features/company-editor.md` (new), `doc/features/interface-spec.md`, `doc/architecture/overview.md`,
`doc/architecture/data-model.md`, `doc/architecture/audit-and-provenance.md`, `doc/design/design-system.md`,
`doc/process/testing-strategy.md`, `doc/product/decision-log.md`.

### Tests run

`python scripts/verify.py --e2e` → all checks passed: privacy guard, ruff check/format, mypy (strict), pytest
**581 passed, 1 skipped** (private workbook smoke), eslint, tsc, Vitest **25 files / 371 tests passed**, vite build,
Playwright **32 passed** (incl. 6 in `companies.spec.ts`). New: 54 backend tests in `test_companies.py`, 20 in
`test_companies_api.py`, 1 in `test_audit.py`; 36 Vitest tests in `src/companies/`, 1 in `fields.test.tsx`.
Screenshots (1440×900, dark/light, list + editor + establishments) reviewed; copies outside the repository.

### Deviations / decisions

- Entry point: Prospection sub-page `/prospection/companies` rather than a new section (I-37).
- The Database Explorer *Ouvrir dans l'éditeur* context action is **not** done: Task 12 is rewriting the explorer's
  context actions on another branch; adding it after the merge is a few lines (`useCompanyEditor()` on `companies`
  rows).
- Webmail e-mail domains refused on companies (I-38) — not in the task text; consistent with the import's rule.
- `PUT` is a full replacement (I-39): omitted fields are cleared, omitted establishments deleted; lists required.

### Open points / risks

- No optimistic-concurrency check: two editors (or the explorer) saving the same company → last write wins.
- Company search uses unindexed `label_key` / `strpos` (fine at V1 scale; Task 17 decides on `pg_trgm`).
- `find_similar` loads every company's names (as the import does); revisit if the base grows by orders of magnitude.
- The Prospects list is plain text; Task 15 should turn items into links opening the Prospect editor, and Task 14 keep
  a link to the Entreprises page in the Prospection header.
- A SIRET swapped between two establishments of the same company in one save is refused as a duplicate (transient
  unique clash); save twice through a temporary value. Rare.
