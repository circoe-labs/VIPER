# Task 06 — Implement Settings taxonomies and internal referents

## Goal
Create safe management UI/API for Roles, Activity Categories, Commercial Segments and Circoe Internal Referents.

## Context
Taxonomies must be extensible from forms without code changes. Referents are business records, not login users.

## Coding Skill Requirement
Before editing code, load and follow `/caveman` and `/coding-guideline` from `~/ai/skills/`.

## Scope
### In Scope
- List/search/add/rename/deactivate Roles.
- Same for Activity Categories and Commercial Segments.
- Add/edit/deactivate Internal Referents.
- Protect in-use values from destructive deletion.
- Reusable selectors/create-new API.

### Out of Scope
- No permissions matrix.
- No agent/mail settings.

## Dependencies
Tasks 03-05.

## Implementation Steps
1. CRUD/deactivate services.
2. Settings sections.
3. Searchable selectors/create-new interaction.
4. Duplicate/in-use diagnostics.
5. Audit mutations.
6. Tests.

## Files Likely Touched
Settings routes/components, taxonomy/referent services, shared selectors, tests.

## Architecture Constraints
Stable IDs survive rename. Deactivation does not orphan references. All mutations audited.

## Testing Requirements
Add/rename/deactivate, duplicate prevention, in-use protection, audit event.

## Acceptance Criteria
- User can extend taxonomies.
- Referents maintained separately from auth.
- Existing links survive rename/deactivation.

## Documentation Updates
Update taxonomy behavior docs.

## Handoff Notes
Selectors feed Company and Prospect editors.

## Implementation report

Date: 2026-09-10 — branch `claude`. Coding rules: `doc/process/agent-brief.md` (I-05).

### What was built

- **Uniqueness in the database** (migration `0005`, ADR-0009, I-34): `unaccent` extension + immutable SQL function
  `label_key(text)` (trimmed, whitespace collapsed, unaccented, lowercase). Taxonomy labels unique on it
  (`uq_<t>_label_key`, replaces `uq_<t>_lower_label`), inactive values included; referents unique on full name (same
  key) and e-mail.
- **TaxonomyService** (`app/services/taxonomies.py`) and **ReferentService** (`app/services/referents.py`): list (search
  word by word ignoring case/accents, active filter, usage counts), create, rename (id and slug stable — I-33),
  deactivate/reactivate (references kept), delete only when unused (`InUseError` with prospects/companies/contact
  tracking counts; FK violation racing past the check translated too). Duplicate pre-check through `label_key` +
  savepoint translation of unique violations (`errors.translated_violations`). Every mutation annotated with the
  server-side actor: `role.created/renamed/deactivated/reactivated/deleted` (same for `activity_category`,
  `commercial_segment`), `internal_referent.created/updated/deactivated/reactivated/deleted` (new `SettingsChange`
  vocabulary in `app/services/audit.py`). Referents never touch `users`.
- **API** `/api/settings/{roles|activity-categories|commercial-segments|referents}` on the protected `api_router`
  (`app/api/routes/settings.py`, I-32): 409 `duplicate` (with the existing value) / `in_use` (with usage), 422
  `invalid` (with the field), 404 `not_found`.
- **Frontend**: `/settings/:section?` page (`src/settings/`) with a tab bar of the four sections, add strip (with
  *Réactiver « … »* for an inactive twin), search + *Tous/Actifs/Inactifs* filter, usage counts, status badges
  (icon + text), inline rename (Enter/Esc, focus restored), deactivate/reactivate, delete confirmation or in-use
  refusal proposing deactivation, referent add/edit dialog, loading/error/empty states, status announcements. No
  optimistic UI. `ApiError` now carries the JSON `detail`.
- **Reusable pickers** for Tasks 07/15: `TaxonomySelect`, `TaxonomyMultiSelect`, `ReferentSelect`
  (`src/settings/selectors.tsx`) on a new accessible `Combobox` primitive (`src/ui/Combobox.tsx`): keyboard
  navigation, accent-insensitive filtering, inactive values only while selected, inline « Créer « … » » through the
  same audited API (I-36). Demonstrated live on `/_dev/ui` (*Sélecteurs de paramètres*). New icons `Check`,
  `ChevronDown`, `Pencil`, `Trash`.

### Files

Backend: `migrations/versions/0005_settings_uniqueness.py`, `app/models/taxonomies.py`, `app/repositories/taxonomies.py`,
`app/repositories/referents.py`, `app/services/taxonomies.py`, `app/services/referents.py`, `app/services/errors.py`,
`app/services/audit.py`, `app/api/routes/settings.py`, `app/api/router.py`; tests `tests/test_settings.py`,
`tests/test_settings_api.py`, `tests/test_schema_constraints.py`.
Frontend: `src/settings/*` (page, sections, shared, messages, selectors, CSS, tests), `src/ui/Combobox.tsx`,
`src/ui/combobox.css`, `src/ui/Combobox.test.tsx`, `src/ui/fields.tsx` (exports `FieldFrame`), `src/ui/icons.tsx`,
`src/api/settings.ts`, `src/api/client.ts` (+ test), `src/lib/text.ts`, `src/routes.tsx`, `src/dev/Showcase.tsx`,
`src/test/settingsApi.ts` (in-memory fake API), `e2e/settings.spec.ts`.
Docs: `doc/features/settings-taxonomies.md` (new), `doc/adr/0009-settings-value-uniqueness.md` (new), decision log
I-32…I-36, ADR-0002 amendment line, `architecture/data-model.md`, `architecture/audit-and-provenance.md`,
`architecture/overview.md`, `features/interface-spec.md`, `design/design-system.md`, `process/runbook-local-dev.md`.

### Tests run

`python scripts/verify.py --e2e` → all gates green: privacy guard, ruff check/format, mypy (strict), **pytest 292
passed** (+47 for this task incl. the schema-constraint update), eslint, tsc, **vitest 318 passed** (22 files; +32),
vite build, **Playwright 26 passed** (+7 in `settings.spec.ts`: add/duplicate/rename/pick/deactivate, in-use vs unused
delete, inline creation from a picker, referent add + picker, dark/light screenshots at 1440×900, no overflow at
1280 px).

### Deviations / decisions

- I-32 API namespace and error codes; I-33 stable slug; I-34 accent-insensitive uniqueness in the database (amends
  ADR-0002's case-insensitive label rule; ADR-0009); I-35 delete-only-when-unused + audit vocabulary; I-36 pickers,
  inline referent creation by "Prénom Nom" split, tab bar instead of a left sub-nav, no optimistic UI.
- Referent homonyms are refused (same full name ignoring case/accents): they would be indistinguishable in pickers.

### Open points / risks

- Migration number `0005` may collide with a migration added by a parallel branch (Task 08/12) — renumber at merge if
  so (the migration has no data dependency).
- Migration 0005 fails on a database that already holds labels differing only by accents/case or referent homonyms
  (none in V1 data yet); the hosting database must allow the `unaccent` extension.
- The pickers are not yet used by a real editor (Tasks 07/15); they are exercised by unit tests, the showcase and E2E.
- `frontend/src/ui/icons.tsx`, `fields.tsx` and `api/client.ts` were touched; parallel branches editing the same
  files may need a trivial merge.
