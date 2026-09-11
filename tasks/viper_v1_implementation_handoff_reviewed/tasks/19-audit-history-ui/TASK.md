# Task 19 — Expose focused recent history and provenance

## Goal
Make who/what/when/source visible on prospects/companies without creating a heavy audit product.

## Context
Core audit already exists from Task 05. This task is only the user-facing history/provenance presentation and Home activity integration.

## Coding Skill Requirement
Before editing code, load and follow `/caveman` and `/coding-guideline` from `~/ai/skills/`.

## Scope
### In Scope
- Prospect recent history timeline/section.
- Company recent history if cheap/relevant.
- Human/import/future-agent actor labels.
- Source/provenance summary.
- Home recent activity feed using same data.

### Out of Scope
- No rollback engine.
- No raw compliance log UI.
- No infinite event taxonomy.

## Dependencies
Tasks 05, 07, 15-16.

## Implementation Steps
1. Build readable event formatter.
2. Add prospect/company history views.
3. Add provenance summary.
4. Connect Home recent activity.
5. Test ordering/content privacy.

## Files Likely Touched
History/provenance UI, formatter, tests.

## Architecture Constraints
Raw audit JSON stays out of normal UI. Avoid leaking sensitive values unnecessarily. Stable actor/entity IDs with useful labels.

## Testing Requirements
Manual/import/company-change/contact alias/status events, ordering, provenance source/date/legal-context presence, privacy-safe display.

## Acceptance Criteria
- User can understand who changed what and when.
- Import/manual changes distinguishable.
- Future agent actor representable.

## Documentation Updates
Document visible event formatting.

## Handoff Notes
Database Explorer may expose deeper raw values only where safe.

## Implementation report

Branch `task-19-history` (worktree `VIPER-wt-prospection`), based on `claude` @ 4eb510c, with `claude` merged at
33fc7c3 (Task 17 global search, Task 15 acceptance notes) — conflicts only in `doc/process/testing-strategy.md` and
`doc/product/decision-log.md` (both sides kept).

### What was built

- **One backend formatter** `backend/app/services/history.py` (ADR-0018, I-130 … I-137): audit events → typed display
  entries. Grouping: one entry per save (subject, actor, source, `request_id`; events without a request id when
  consecutive and < 5 s apart; Home's cross-record feed also joins a request's events interleaved with concurrent saves).
  Entry = newest event id/time, actor `{kind: human|import|system|agent, label, id, on_behalf_of}` (an import by its
  file name, « confirmé par »), source, actions, a French title, value-free `summary` phrases and `changes`
  `{label, before, after}`: a French label per field (catalogue `FIELDS` / `NOT_SHOWN`, every audited column of a
  prospect's or company's rows classified — test), enums in French, Europe/Paris dates, Oui/Non, French phones by
  pairs, references by the label snapshotted in the event or looked up once per page (companies, roles, segments,
  categories, referents), child rows named by their address/number/name at the time (from the event or the row's
  earlier identity event), one « E-mail principal : A → B » line for a primary switch (phones, establishments too),
  « E-mail désactivé / retiré », « Opposition enregistrée / levée — motif : … », « Étape : Contacté → Relance 1 ».
  Payload policy respected: values shown as stored (full in V1, masked when the switch tightens), `[masked]` →
  « (masqué) », secret-looking or unlabelled fields never shown, structured values never as JSON.
- **API** (protected): `GET /api/prospects/{id}/history` and `GET /api/companies/{id}/history` (`limit` 1–50, default
  10; `before` = `next_cursor`; newest first by `occurred_at`, `id`; events read 100 at a time until one more entry
  starts, so a save is never split). `audit.history` / `subject_history` gained the `before` cursor;
  `identity_changes` repository query.
- **Provenance summary**: the Prospect editor's sources (already served by Task 15's view model — the same query as
  `provenance.list_sources`, joined with the batch file name) now carry `recorded_by`, the history actor, so the block
  shows type · reference, collection date, « par » + the actor badge, and the legal basis / collection context (or
  « non renseigné »).
- **Frontend**: `src/history/HistoryTimeline.tsx` + `format.ts` + `history.css` (rail timeline, badge *Vous* / a
  person / *Import « fichier »* / *Système* / *Agent*, source, relative + absolute date, title, change lines with
  before muted → after, long creations folded behind « Afficher les N autres », *Voir plus*, loading / error / empty
  states); `src/api/history.ts` (`useHistory`, infinite query). Prospect editor: *Historique* section below
  *Provenance* (existing prospects), refreshed after every save / opposition change. Company editor: *Historique*
  section (existing companies), refreshed after a save. Home *Dernières modifications*: the formatter's value-free
  summary, actor object (agents named « Agent « … » »), two-line wrap with the full text as tooltip; `activity.ts`
  keeps only the record name, origin, counts and dates (Home/editor split documented, I-133).
- **Editor polish**: an imported person's **empty** Rôle / Intitulé exact / Entreprise shows an actionable empty state
  instead of « Importé, à confirmer » (I-136). **Bug fixed** (found by the new E2E): the editor collapsed inner
  spaces of a stored alias's source reference, so every save of an imported person rewrote the import reference (the
  real sheet name ends with a space) and wrote a spurious « E-mail modifié » event; stored references are now sent back
  unchanged (I-137).
- Home's recent edits now include `agent` actors besides people (none exist in V1; representable and tested).

### Files

Backend: `app/services/history.py`, `app/api/history.py` (new); `app/api/routes/prospects.py`, `companies.py`
(history routes; `SourceOut.recorded_by`), `home.py` (`EditItemOut`), `audit.py` (docstring);
`app/services/home.py` (`recent_edits` through the formatter), `audit.py` (`history(before=)`),
`import_batches.py` (`IMPORT_ACTOR_PREFIX`), `prospect_editor.py` (`SourceView.recorded_by`);
`app/repositories/audit.py` (cursor, `identity_changes`); tests `test_history.py`, `test_history_api.py` (new),
`test_home.py`, `test_home_api.py`, `test_prospect_editor.py`, `test_prospects_api.py` (adapted to the new contracts).
Frontend: `src/history/*` (new, with tests), `src/api/history.ts`, `src/test/historyApi.ts` (new);
`src/api/home.ts`, `prospects.ts`, `companies.ts`; `src/home/activity.ts`, `RecentActivity.tsx`, `home.css`,
`activity.test.ts`, `HomePage.test.tsx`; `src/prospects/ContextSections.tsx`, `ProspectEditor.tsx`,
`EmploymentSections.tsx`, `pickers.tsx`, `prospectForm.ts`, `prospects.css`, `ProspectEditor.test.tsx`,
`prospectForm.test.ts`; `src/companies/CompanyEditor.tsx`, `CompanyEditor.test.tsx`; fakes `src/test/prospectsApi.ts`,
`companiesApi.ts`, `renderProspectEditor.tsx` (signed-in `CurrentUserContext`); Playwright `e2e/history.spec.ts` (new).
Docs: `doc/architecture/audit-and-provenance.md` (*Visible history*), `security-and-privacy.md`,
`doc/features/prospect-editor.md`, `company-editor.md`, `home-dashboard.md`, `doc/process/testing-strategy.md`,
`runbook-local-dev.md`, ADR-0018, decision log I-130 … I-137.

### Tests run

`python scripts/verify.py --e2e` with `VIPER_E2E_DATABASE_URL=…/viper_wt3_e2e`, `VIPER_E2E_WEB_PORT=5188`,
`VIPER_E2E_API_PORT=8148` (backend `.env` on `viper_wt3` / `viper_wt3_test`), after merging `claude` @ 33fc7c3:
privacy guard OK, ruff check/format OK, mypy OK (186 files), **pytest 947 passed, 2 skipped** (private workbook
tests), eslint OK, tsc OK, **Vitest 50 files / 598 tests**, vite build OK, **Playwright 74 passed** — "All checks
passed". After a last change to `e2e/history.spec.ts` (screenshots wait for loaded content), `npx playwright test`
again: 74 passed. New tests: `test_history.py` (18: one per kind of event — manual edit, import creation with the file
and the confirming person, company change, primary switch + verification with identities from earlier events,
deactivation/removal, tracking stage, opposition set/lifted with reasons, explorer source, command-line system entry,
company fields/categories/establishments, agent actor in the history and on Home — grouping by save / by time / across
records, cursor pages never cutting a save with reads of 3 events, masked personal values shown as stored, secrets /
masked / structured values never shown, catalogue coverage), `test_history_api.py` (8: 401 ×2, bounds ×3, an editor
save read back as one entry by the signed-in user with source `ui`, opposition reason, company pages);
`src/history/format.test.ts`, `HistoryTimeline.test.tsx` (each actor kind, change lines, *Voir plus* with the cursor,
folded creation, empty), editor tests (empty-state hints, provenance badge + history, history refresh), company editor
history, Home wording, `prospectForm.test.ts` (stored source reference unchanged); Playwright `e2e/history.spec.ts`.

Intermediate runs, for the record: before the merge, `auth.spec.ts` failed on the known strict-mode issue (Home's feed
also names « Pilote E2E »), fixed by Task 17's first commit, now merged. After the merge, one full run showed Home
splitting one save into three lines: concurrent specs' events interleaved in the cross-record feed — fixed by joining a
request's events per record in Home's feed (`group_events(…, across_records=True)`, test added, I-131). The same run
had one `import.spec.ts` timeout on the explorer grid still loading under load (unrelated code; passed in the two
following full runs).

Screenshots (dark/light, 1440×900) of the editor's *Historique* and Home's *Dernières modifications*:
`frontend/test-results/screenshots/history-*.png`, reviewed (fixes: Home lines wrapped instead of truncated, « par »
kept with the recorder badge, long import names wrap inside badges, screenshots wait for the loaded history).

### Deviations and decisions

- French wording of the history is produced by the backend (I-130, ADR-0018), unlike refusal codes (I-32).
- Home API contract changed (I-135): `recent_edits[].actor` + `summary` replace `actor_display` + `actions`; Task 16's
  tests were adapted accordingly (`test_home.py`, `test_home_api.py`, `HomePage.test.tsx`, `activity.test.ts`). In
  `test_home.py` the second save of the grouping test now binds its own request id (two saves never share one in
  reality; with the cross-record grouping a shared fake id would join them).
- Prospect view `sources[].actor_display` replaced by `recorded_by` (history actor); `test_prospect_editor.py`
  adapted.
- Home's feed includes `agent` actors (I-133); imports keep their own list (not repeated in the feed).
- The history endpoints do not 404 for a deleted record (the audit outlives it, I-132).
- Bug fix outside the strict scope (I-137): stored alias source references were rewritten by every editor save.

### Open points

- Reference labels are current unless snapshotted by the service (a renamed role shows its new name in older creation
  lines); snapshotting more labels would be an audit-core change.
- The history shows values as stored: tightening `POLICY.personal_values` affects new events only (open question #2).
- Home's check in `e2e/history.spec.ts` relies on the save still being among the 8 latest when Home loads right after
  it (other specs save concurrently); the screenshots no longer depend on it.
