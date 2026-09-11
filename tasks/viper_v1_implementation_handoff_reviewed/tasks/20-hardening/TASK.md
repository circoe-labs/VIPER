# Task 20 — Integration hardening and release report

## Goal
Run the complete V1 as an integrated system, close correctness/security/UX gaps and produce the final implementation report.

## Context
This is a release gate, not a place to add new features.

## Coding Skill Requirement
Before editing code, load and follow `/caveman` and `/coding-guideline` from `~/ai/skills/`.

## Scope
### In Scope
- Full test/E2E suite.
- Private local BASE_CLIENT import compatibility run without committing/logging PII.
- Import→edit→export.
- Company/Prospect/Settings flows.
- Contactability and verification semantics.
- Database Explorer read/edit/SQL safety.
- Home drilldowns.
- Auth/session/security review.
- Theme/logo checks.
- Performance/accessibility/error/loading/empty states.
- Backup/retention/deployment open decisions clearly reported.
- Final implementation report.

### Out of Scope
- No new product scope.
- No agents/mail/Calendly unless separately approved later.

## Dependencies
Tasks 01-19 except explicitly deferred optional Task 17 if documented.

## Implementation Steps
1. Clean install/migrate/seed.
2. Run automated suite.
3. Run private legacy workbook compatibility scenario.
4. Run user-critical E2E flows.
5. Review public-repo data leakage and secrets.
6. Review performance/accessibility/visual alignment.
7. Fix regressions only.
8. Produce final report with unresolved deployment/legal/ops decisions.

## Files Likely Touched
Cross-project tests, docs, deployment config, final report.

## Architecture Constraints
Do not weaken guards to make tests pass. Do not commit private source data. No fake future capabilities.

## Testing Requirements
All prior task gates, private-data leak check, DNC persistence, auth, SQL read-only, import/export fidelity, keyboard/accessibility, common laptop viewport.

## Acceptance Criteria
- V1 runs end-to-end.
- Core workflows are reliable.
- Private data remains private.
- No known source-of-truth contradiction remains undocumented.
- Final report complete.

## Documentation Updates
Finalize README/runbook/implementation report using template.

## Handoff Notes
Use `../../templates/final-implementation-report-template.md`.

## Implementation report

Branch `task-20-hardening` (worktree `VIPER-wt-home`), based on `claude` @ 35b0074. The full release report is
`doc/process/final-implementation-report.md` (template of `templates/final-implementation-report-template.md`);
this section lists what the task changed.

### Carried defects fixed (each with a test that fails on the old code)

- **Stale response after a save** (`b58fe16`, I-150): TanStack Query reuses the first request of a new key on
  invalidation, so a search typed before a save could bring the pre-save list back. `frontend/src/api/refresh.ts`
  `refreshAfterWrite` cancels then invalidates; every write uses it; ESLint forbids a bare `invalidateQueries`. Audit of
  companies, Prospection, Settings, explorer and import history: keys carry their parameters, no fetched data in
  component state.
- **`provision-sql-reader` race** (`5365d31`, I-151): advisory locks are per database (verified), the role is
  cluster-wide — `provisioning_lock(url)` holds the lock in the `postgres` maintenance database around the whole
  provisioning transaction (fallback: target database). Test runs two provisioning commands at once; 20 concurrent
  CLI processes on two databases all succeed.
- **Vitest timeouts** (`382a6bd`, I-152): long Company editor / new-prospect flows split into one behaviour per test,
  shared `src/test/fill.ts`; both 15 s suite timeouts removed; slowest test 5.7 s → 1.8 s, also under backend load.
- **`history.spec.ts` Home check** (`3d5fdcf`, I-153): Home's answer read right after the save, the save required as
  one entry, the page rendering that captured answer; 9 injected saves break the old check, not the new one.
- **Explorer header tab stops** (`7a065f7`, I-154): one roving tab stop for the header row, actions on keys
  (Enter, Shift+Enter, Alt+↓ / Shift+F10, Shift+←/→), icons and resize edge mouse-only; 20 → 1 stops for 5 columns.
- **Statistics beyond Home** (`0b34075`, I-155, extends ADR-0019): measured on 20 000 prospects in the three planner
  states — the export's `selectinload` batches degraded to 154 statements and 8–11 s of database time when a VACUUM
  had zeroed the statistics; now `subqueryload` under `whole_base_plan`: 16 statements, ≈ 0.25 s in every state. The
  explorer (single-table statements, ≈ 40 ms) needs nothing; no `ANALYZE` after imports (rationale in I-155).
  Guard: `tests/test_export_explorer_statistics.py`.

### Found and fixed by the release checks

- **Import dedup, one name part** (`a1da317`, I-157): rows with one name part and no e-mail were never matched — the
  private re-import created 12 duplicates, and an opposed person of that shape could have been recreated as
  contactable. Such a key now matches with the same company key (`same_person`).
- **Explorer search on enum columns** (`d0d08bd`, I-161): any search of a table with an enum column answered 500
  (`validate_strings` enum type bound to the search text); `import.spec.ts` had passed on a weak assertion, now strict.
- **422 echo** (`d59e35c`, I-159): FastAPI's validation errors returned the submitted `input` (a password object in
  the fresh-clone check); the handler drops it.
- **CLI password via Windows PowerShell pipe** (`a6b04f4`, I-160): a leading BOM was kept in the password.
- **Contrast** (`2558ed6`, I-158): the grid's NULL/masked markers faded below 4.5:1 (found by axe).
- **Clipped picker values** (`52833b2`): Combobox text now ends with an ellipsis.
- **E2E robustness** (`aa8f582`, `ac7d561`): `importProspects` re-analyses on a legitimate `preview_outdated`
  caused by a parallel test's similar company; the import commit's result gets a 15 s wait at 12 workers.

### Added

- Security (`d931f52`, I-156): API security headers middleware, `hide_parameters=True`, CSRF walk over every unsafe
  route. Dependency audits clean (`npm audit`, `pip-audit`).
- Accessibility: `e2e/accessibility.spec.ts` (axe-core, 10 pages/dialogs × 2 themes, `@axe-core/playwright` 4.13.0
  devDependency) and `e2e/keyboard.spec.ts` (keyboard-only working session with visible-focus checks).
- Docs: `README.md` (what VIPER is, complete quick start), `doc/process/runbook-production.md` (requirements, install
  and upgrade, proxy, logging, backups/retention open decisions), `doc/process/final-implementation-report.md`,
  `doc/product/open-questions.md` (state of each), decision log I-150…I-161, ADR-0019 status note; feature and
  testing docs updated with each fix.

### Verification

- Worktree, final code: `python scripts/verify.py --e2e` → privacy guard OK, ruff/format/mypy clean, pytest 966
  passed + 2 private skipped, ESLint/tsc clean, Vitest 610, build OK, Playwright 95; then two more full runs 95 + 95;
  `--workers=12`: 94/95 once (commit wait, fixed in `ac7d561`), then 95 + 95.
- Fresh clone of the branch (`a6b04f4`) on new databases, following README + runbook only: migrate, seed, provision,
  create user, `/api/health` 200, sign-in 200; `verify.py --e2e` all green (pytest 965, Vitest 610, Playwright 95).
  Clone and databases deleted afterwards.
- Private workbook end to end on the throwaway `viper_wt2` (aggregates only, database reset): see the report's
  table — 328 rows imported, re-import with the opposition held, export equal to the database, 2 286 legacy values
  kept, 0 legacy markers in Référent.
- Leak scan of the whole history (91 commits, all refs): 0 spreadsheets/sources ever committed, 0 hits for the
  workbook's e-mails, phones, full names and company names.
- Performance (20 000 prospects, three planner states): Home ≤ 204 ms, counters ≤ 95 ms, deep page ≤ 133 ms, search
  p95 47 ms, explorer page ≈ 37 ms, export ≈ 21 s.
- Visual: 44 screenshots (every main page, both themes, 1440×900 and 1280×800) reviewed; no overflow.

### Open points

- Not deployed, CI never ran on GitHub (nothing pushed). Hosting, backups, retention, stale threshold, legacy
  « Mode de contact » / second « A contacter », logo neon vs UI green: product/ops decisions, listed in the report.
- Cosmetic: the Prospect editor's role picker shows its placeholder until the roles list first loads.
- One real-file row (one name part, no company, no e-mail) is created again by each acknowledged re-import.
