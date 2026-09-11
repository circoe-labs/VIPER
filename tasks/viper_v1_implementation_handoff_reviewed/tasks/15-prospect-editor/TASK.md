# Task 15 — Implement reusable Prospect create/edit drawer and verification UX

## Goal
Build the central low-effort form for adding/verifying/updating prospects, contact aliases, contactability and lightweight contact tracking.

## Context
The user emphasized prefilled data, field/section verification feedback and minimum manual effort. Company editing is delegated to Task 07 editor.

## Coding Skill Requirement
Before editing code, load and follow `/caveman` and `/coding-guideline` from `~/ai/skills/`.

## Scope
### In Scope
- Same add/edit drawer.
- Identity.
- Company selector + open/create company flow.
- Role selector + inline create; exact job title.
- Activity status + employment verification date.
- Email/phone alias repeaters with primary, verification, origin/source.
- Durable do-not-contact control.
- Contact tracking: planned date, stage, response, appointment, referent.
- Yellow warning on imported dynamic/unverified values.
- Dirty state, validation, Save/Cancel/Delete-safe.
- Save & Next preserving current queue.
- Provenance/recent history access.
- Company-change re-verification behavior.

### Out of Scope
- No external enrichment.
- No email generation/sending.
- No full CRM company/project editor inside this drawer.

## Dependencies
Tasks 05-07 and 14.

## Implementation Steps
1. Define form model/validation.
2. Build reusable drawer.
3. Add taxonomy/company selectors.
4. Add verification visuals and contact aliases.
5. Add contactability/tracking controls.
6. Implement transactional save + company-change behavior.
7. Add Save & Next.
8. Audit/provenance integration.
9. Tests.

## Files Likely Touched
Prospect form components, services, validation, alias editors, tests.

## Architecture Constraints
No company field duplication. Employment and contact-channel verification stay separate. Permanent suppression cannot be casually cleared. Save is atomic.

## Testing Requirements
Create/edit, role inline create, alias primary uniqueness, employment verification, company change, blocked status, tracking/response/appointment, Save & Next, dirty cancel, audit.

## Acceptance Criteria
- Same form handles add/edit.
- Existing values prefilled.
- User can see what needs verification.
- Multiple contacts work.
- Save & Next is reliable.
- All mutations traceable.

## Documentation Updates
Update field semantics/help copy docs.

## Handoff Notes
Global visual reference: `../../visuals/neon-command-brand-direction.png`.

## Implementation report

Branch `task-15-prospect-editor` (worktree), based on `claude` @ d818cc4, with `claude` merged at 3da562d (Task 16
Home) — one conflict in `app/core/business_time.py`, resolved by keeping Task 16's `start_of_day` and adding
`business_day` / `business_moment`.

### What was built

- **ProspectService for the editor** (`backend/app/services/prospect_editor.py`, ADR-0015): the view model (company
  summary, role, employment + `verification_state` from the Prospection expression, `employment_imported_unverified`,
  aliases with `imported_unverified`, tracking in business days with week / appointment time / referent / status
  since, sources with import file name, import-row count, business day, stale threshold, aggregate `version`) and one
  atomic save composing inline role creation (`taxonomies.create_value`), `change_company` (I-13), identity/employment
  with an explicit verification action (`keep`, `verified_now`, `verified_on`, `clear`), the e-mail and phone full
  lists, `save_contact_tracking` and, on creation, `add_manual_source`. `set_contactability` (reason required both
  ways, through `mark_/clear_do_not_contact`), `delete_prospect` (refused for an opposed prospect). Every write locks
  the prospect and checks the aggregate version (prospect + aliases + tracking) → `ConflictError`.
- **ContactChannelService** (`contact_channels.py`): import normalizers reused (e-mail syntax, French phones `+33…`),
  full-list save with exactly one active primary written in two flushes, removal vs deactivation, refusals with paths
  (`emails.1.address` `repeated`, `multiple`, `inactive`, `verification_action`, `unknown`, `exchange`), explicit
  `verified_now`; an edited value becomes a never-verified `manual` one.
- **API** `/api/prospects` (protected): `GET /{id}`, `POST`, `PUT /{id}` (full lists required, unknown fields refused),
  `PUT /{id}/contactability`, `DELETE /{id}?version=`; new stable codes 409 `conflict` and `do_not_contact`.
- **Frontend editor** (`frontend/src/prospects/`), the default of `ProspectEditorContext` (explorer fallback removed):
  a 64 rem two-column drawer — Identité · Emploi (server-searched company picker with « Créer l'entreprise « … » »
  through the Company editor; role picker creating a role with the save; exact title; activity segmented choice) ·
  Vérification de l'emploi (*Vérifié aujourd'hui*, a past date, clear) · E-mails · Téléphones (repeaters with primary
  radio, one-click *Vérifié*, actions menu: invalid / unknown / not verified / deactivate / remove, origin and source,
  type from the numbering plan, domain mismatch warning) · Opposition (confirmation dialogs with reason, apart from the
  save) · Suivi de contact (planned date + derived week + quick dates, stage with *depuis le*, response, appointment day
  and time, referent emphasized once an appointment exists) · Entreprise (summary + Company editor) · Provenance
  (sources; manual provenance fields for a new person; clean slot for Task 19). Visual feedback always glyph + text:
  warning edges/outlines/« Importé, à confirmer » for imported unverified values, success badge with date, stale only
  with `VIPER_VERIFICATION_STALE_DAYS`, company-change banner and alias « À revérifier ». Dirty-state bar, Save, revert
  / close, Delete-if-safe with the list of what goes, *Enregistrer et suivant* through `ProspectQueue.next` (end of
  list said; *Enregistrer et nouveau* keeping the company for a new person), refusals on their fields, 409 with
  *Recharger la fiche*, Ctrl+S / Ctrl+Entrée / Échap (guarded) / Enter in one-line fields.

### Files

Backend: `app/services/prospect_editor.py`, `app/services/contact_channels.py`, `app/api/routes/prospects.py` (new);
`app/api/router.py`, `app/api/errors.py`, `app/services/errors.py` (`ConflictError`, `DoNotContactError`),
`app/services/prospects.py` (`ProspectInput.employment_verified_at`), `app/repositories/prospects.py` (lock, version
rows, sources with batches, import-row count), `app/repositories/companies.py` (`company_summary`),
`app/services/prospection/query.py` (`prospect_verification_state`, public `iso_week`), `app/core/business_time.py`;
tests `test_prospect_editor.py`, `test_prospects_api.py`.
Frontend: `src/prospects/*` (editor, sections, pickers, form model, labels, messages, CSS, 8 test files),
`src/api/prospects.ts`, `src/prospection/prospectEditor.tsx`, `src/ui/Combobox.tsx` (`id`, `warning`,
`onQueryChange`, cancellable creation), `src/ui/fields.tsx` + `fields.css` (`data-warning` outline),
`src/companies/CompanyEditorProvider.tsx` (`onClosed`), `src/api/settings.ts` (refusal codes), test helpers
`src/test/prospectsApi.ts`, `renderProspectEditor.tsx` (+ `fetchMock` returned by the prospection/companies fakes);
adapted tests `ProspectionPage.test.tsx`, `HomePage.test.tsx` (the default editor can create), `Combobox.test.tsx`;
Playwright `e2e/prospect-editor.spec.ts` (new), `e2e/prospection.spec.ts` (editor instead of the explorer fallback).
Docs: `doc/features/prospect-editor.md` (new), ADR-0015, decision log I-100 … I-109, interface-spec,
prospection-kpis (contract implemented), data-model, overview, audit-and-provenance, testing-strategy, runbook.

### Tests run

`python scripts/verify.py --e2e` with `VIPER_E2E_DATABASE_URL=…/viper_wt3_e2e`, `VIPER_E2E_WEB_PORT=5188`,
`VIPER_E2E_API_PORT=8148`, after merging `claude` @ 3da562d: privacy guard OK, ruff check/format OK, mypy OK (176
files), **pytest 887 passed, 2 skipped** (private workbook smokes), eslint + tsc OK, **vitest 569 passed** (47 files),
vite build OK, **Playwright 68 passed**.

New tests: backend 47 (`test_prospect_editor.py` 36, `test_prospects_api.py` 11 incl. 5 parametrized 401s);
frontend 32 in `src/prospects/` (form model 7, labels 4, editor 6, aliases 4, opposition/deletion 4, Save & Next 2,
creation 3, role + tracking 2), plus Prospection and Home tests adapted; Playwright 4 (Save & Next through the
filtered queue with verification, new primary e-mail and planned contact; creation with a company created inline;
opposition counted under *Opposition*; screenshots) and 2 Prospection specs adapted. Screenshots (dark/light,
1440×900 and 1280×800, editor top and alias sections, « à vérifier » and « vérifié » states) reviewed — two layout
issues fixed after the first review (truncated *Inconnue* / exact title, repeated long warnings and hints) — and copied
to the session scratchpad `task15-screenshots/`.

### Deviations and decisions

- Inline role creation happens **with the save** (`role_label`), not immediately like the Company editor's segment /
  category pickers (I-104) — atomic, no orphan role after a cancelled edit.
- Verification is sent as explicit actions (I-101) rather than whole-state statuses; the concurrency version is an
  aggregate fingerprint rather than `updated_at` alone (I-102). ADR-0015 records both.
- The contactability operation requires a reason to **set** an opposition too (the domain function keeps it optional
  for other callers).
- A new person's activity defaults to *Inconnue* (nothing assumed); the manual provenance context defaults to
  « Saisie manuelle — prospection B2B » (no legal basis asserted).
- Bug found by the tests and fixed: a dialog's form submit inside the drawer bubbled through the React portal and
  submitted the editor's own form (`stopPropagation` in the opposition dialog).

### Open points

- The queue shows the order when the editor opened (*Prospect 2 sur 3* after the first person left the segment), as
  the Task 14 contract specifies; the list behind refreshes its counts.
- Two lines swapping their values in one save are refused (`exchange`: save in two steps) — rare, documented.
- Task 19 adds the change history below *Provenance*; a `role.created` from the editor has the role as subject, so it
  shows in the role's history, not the prospect's.
- `canCreate: false` stays in the contract for test implementations; with the real editor it is always true.
