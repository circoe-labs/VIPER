# Task 16 — Implement Home global dashboard from real V1 data

## Goal
Create the overall activity/database-health homepage the user requested, with actionable drill-downs and no fake integrations.

## Context
Home should give global visibility first, then next actions. Manual contact tracking now supports response/no-response and appointment metrics.

## Coding Skill Requirement
Before editing code, load and follow `/caveman` and `/coding-guideline` from `~/ai/skills/`.

## Scope
### In Scope
- Database-health KPIs.
- Contact activity: planned/due/contacted/no-response/responses/appointments.
- Lightweight quote/follow-up/won if manually recorded.
- Monthly progress toward contacted/appointment targets when meaningful.
- Next actions.
- Recent import/manual activity.
- Click-through to Prospection filters.
- Clear states for future agent/email/Calendly data being unavailable.

### Out of Scope
- No fake IProspect/IContact.
- No invented mail or Calendly ingestion.
- No heavy BI suite.

## Dependencies
Tasks 14-15; audit core from Task 05.

## Implementation Steps
1. Define aggregate service/KPI formulas.
2. Build cards and next-action list.
3. Add recent activity.
4. Link drill-down filters.
5. Add empty/limited-data states.
6. Test.

## Files Likely Touched
Home route/components, aggregate queries/services, tests.

## Architecture Constraints
KPIs derived from canonical tracking/verification/contactability semantics. Queries explicit/indexed. Target cards are informative, not the sole dominant screen hierarchy.

## Testing Requirements
Aggregate correctness, no-response logic, target progress, drill-downs, empty states, no mocked agent values.

## Acceptance Criteria
- Home answers “où en est l’activité/la base ?” and “quoi faire ensuite ?”.
- Real data only.
- Drill-down works.

## Documentation Updates
Document KPI definitions.

## Handoff Notes
Global visual reference: `../../visuals/neon-command-brand-direction.png`.

## Implementation report

Branch `task-16-home` (worktree `C:\Projects\VIPER-wt-home`), based on `claude` @ `d818cc4`, `claude` @ `1c432b9`
merged in. Coding-guideline skills replaced by `doc/process/agent-brief.md` (as for every task).

### What was built
- **`GET /api/home`** (protected, read-only) — `app/services/home.py` + `app/api/routes/home.py`, 9 SQL statements
  whatever the base size (≈ 0.25 s on 20 000 prospects with history):
  - prospect counts = `count_segments` without criteria (the 16 canonical segments, ADR-0014, reused verbatim), plus
    companies and the current commercial stages (`quote_sent`, `quote_follow_up`, `won`, `not_interested`);
  - monthly progress (current month + 5 before, Europe/Paris): prospects whose tracking **first** entered a contacted
    stage that month and prospects who **first** reached an appointment stage that month, from
    `contact_tracking_status_history`, excluding a first entry written by an import; informative targets
    `VIPER_MONTHLY_CONTACT_TARGET` (100) / `VIPER_MONTHLY_APPOINTMENT_TARGET` (10);
  - next actions: appointments of the next 7 days (actionable, soonest first), `due` (oldest planned first), answers
    without appointment (actionable, not `not_interested`, oldest answer first) — 5 each + totals;
  - recent activity: 5 latest import batches; latest human saves on prospects/companies grouped per request
    (`audit.recent_activity` gained `actor_types`), structured actions only — no field values, no raw JSON.
- **Accueil `/`** (`frontend/src/home/`): *État de la base* (Base, Vérification) and *Activité de contact* (Suivi de
  contact, Suivi commercial léger) as link cards → `/prospection?segment=…` / `?tracking_status=…` /
  `/prospection/companies`; *Prochaines actions* (each person opens in its Prospection queue); three equal panels
  *Progression du mois* (meters capped at the target with text values, six-month columns, a table view),
  *Derniers imports* (committed → `?import_batch=`), *Dernières modifications* (French formatter in one file,
  `activity.ts`); loading/error/empty-base states; one V1-scope sentence (no e-mail, Calendly or agent data).
- Docs: new `doc/features/home-dashboard.md` (all KPI definitions and their rationale), `prospection-kpis.md`,
  `interface-spec.md` (Home as implemented, route map), `design-system.md` (Home section), `audit-and-provenance.md`
  (reads), runbook (Home settings), testing strategy, decision log **I-110 … I-117**. No ADR (no significant technical
  choice beyond ADR-0014's reuse).

### Files
Backend: `app/services/home.py`, `app/api/routes/home.py`, `app/api/router.py`, `app/core/business_time.py`
(`start_of_day`), `app/core/config.py`, `app/services/prospection/segments.py` (uses `start_of_day`),
`app/services/audit.py` + `app/repositories/audit.py` (`actor_types`), `.env.example`; tests `tests/test_home.py`,
`tests/test_home_api.py`, `tests/test_prospection_performance.py` (Home on 20 000 prospects).
Frontend: `src/home/*` (page, next actions, progress, recent activity, formatter, CSS, tests), `src/api/home.ts`,
`src/routes.tsx` (explicit page list), `src/imports/ImportHistory.tsx` (`BATCH_STATUS` exported),
`src/test/homeApi.ts`, shell/theme/exploitation/user-menu tests stub `/api/home`; removed `src/shell/PlaceholderPage.tsx`;
`e2e/home.spec.ts`.

### Tests run (after merging `claude` @ `1c432b9`)
`VIPER_E2E_DATABASE_URL=…/viper_wt2_e2e VIPER_E2E_WEB_PORT=5186 VIPER_E2E_API_PORT=8146 python scripts/verify.py --e2e`
→ privacy guard OK, ruff/format/mypy clean, **pytest 838 passed, 2 skipped** (private), eslint/tsc clean, **vitest
522 passed**, vite build OK, **Playwright 64 passed**. Screenshots dark/light at 1440×900 and 1280×800 reviewed (first
screen = state of the base + contact activity; progress panel secondary), copied to the session scratchpad
`task16-screenshots/`.

### Deviations / decisions
- Monthly "contacted" and "appointments" are defined from the status history with imports excluded (I-112, I-113);
  "appointments obtained" is not `appointment_at` in the month (reason in I-113).
- The obsolete shell test "renders placeholder pages without data" was removed with the placeholder itself: every
  navigation section now has its page (I-117). Other shell tests only gained a `/api/home` stub.

### Open points / risks
- An appointment (or response) recorded only as a date, without a stage change, is not in the monthly figures (it is
  in the `appointments` / `responses` segments) — documented limit.
- *Correction after orchestrator review:* the first version of this report and of `home-dashboard.md` / I-113 said a
  Database Explorer stage change writes no history row. That was wrong: explorer tracking writes go through
  `save_contact_tracking` (I-64), which records the history with the signed-in user, so they count in the monthly
  figures — now proven by `test_database_explorer_stage_changes_count_in_the_month` (`tests/test_home_api.py`).
- The edits feed wording is intentionally minimal (Task 19 replaces `activity.ts` over the same data; the API
  already carries entity type, action, stage before/after, source and current record name).
- Task 15 (Prospect editor) had not landed on `claude` when this branch was verified; Home's links already follow the
  `?prospect=<id>` contract and *Ajouter un prospect* appears on the empty base once `canCreate` is true.

### Fix after orchestrator review
Explorer-history correction (see *Open points*): new API test, `home-dashboard.md`, I-113 and this report corrected.
`python scripts/verify.py` → privacy guard OK, ruff/format/mypy clean, **pytest 839 passed, 2 skipped**, eslint/tsc
clean, vitest 522 passed, build OK (no frontend or E2E change since the `--e2e` run above).
