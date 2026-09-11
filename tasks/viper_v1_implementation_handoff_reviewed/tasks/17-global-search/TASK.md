# Task 17 — Implement global VIPER search

## Goal
Provide fast cross-entity lookup from any page.

## Context
This was a strong accepted UX recommendation; it reduces friction for a database-maintenance tool.

## Coding Skill Requirement
Before editing code, load and follow `/caveman` and `/coding-guideline` from `~/ai/skills/`.

## Scope
### In Scope
- Search prospects by name/email/phone.
- Search companies by display/legal name, SIREN, site/domain.
- Optionally establishments by SIRET.
- Keyboard navigation.
- Open Prospect/Company/Database context.
- Efficient debounced backend query.

### Out of Scope
- No external/web search.
- No search platform overbuild.

## Dependencies
Tasks 03, 07, 14-15.

## Implementation Steps
1. Define result contract.
2. Add indexes/query service.
3. Add shell search UI.
4. Add keyboard navigation.
5. Test.

## Files Likely Touched
Search service, shell component, tests.

## Architecture Constraints
Parameterized query; result contract exposes typed entity IDs/context, not raw DB rows.

## Testing Requirements
Name/company/email/SIREN/SIRET/domain search, keyboard navigation, no-result/error, performance.

## Acceptance Criteria
- Common entities reachable quickly.
- Search remains compact and safe.

## Documentation Updates
Document indexed fields.

## Handoff Notes
If schedule is extremely constrained, orchestrator may explicitly defer this task; do not silently omit it.

## Implementation report

Branch `task-17-global-search` (worktree `C:\Projects\VIPER-wt-home`), based on `claude` @ `8d95ef6`, fast-forwarded
to `3da562d`, then `claude` @ `16a1126` (Task 15 merged) merged in. Coding-guideline skills replaced by
`doc/process/agent-brief.md`.

### Step 0 — E2E flake fix (commit `f6f9367`)
`auth.spec.ts` asserted `getByText('Pilote E2E')` anywhere; Home's activity feed also names that user once other specs
edit data (strict-mode violation). It now asserts the header's user zone:
`getByRole('banner').getByText('Connecté : Pilote E2E')`. No other spec asserts the signed-in user unscoped
(`database-edit.spec.ts` reads it inside one audit row).

### What was built
- **`GET /api/search?q=`** (protected, read-only; `app/services/search.py`, `app/api/routes/search.py`): typed, grouped
  hits — prospects (own first/last name in any word order, any e-mail address incl. former ones, phone digits),
  companies (display/legal name, SIREN, e-mail domain, website host), establishments (SIRET, name, city). Each hit:
  `type`, `id`, `label`, `sublabel`, `match {field, kind, value}`, `badges` (`do_not_contact`, `inactive`, `primary`),
  `open {editor, id}`, `record {table, id}` + typed context. 5 per group with `has_more`, groups ordered by their best
  match; ranking exact → prefix → contains, then by name; `q` 2–200 characters (422 `invalid`/`q`/`length`); bound
  parameters only; 3 statements per search whatever the base size.
- **Matching**: new SQL functions `search_key` (`unaccent` + lowercase) and `person_search_key`; words ≥ 3 characters
  match anywhere, shorter words only at a word start (`ma` → Martin, not Thomas); SIREN/SIRET on ≥ 3 digits, phones on
  ≥ 4 (national 0 dropped, Prospection's `phone_needle`); a SIRET also finds its company; an e-mail address or URL finds
  the company of its domain/host.
- **Indexes** (migration **0007**, ADR-0017): `pg_trgm` + 7 GIN trigram indexes (prospect full-name key, e-mail address,
  phone number, company display/legal name keys, establishment name/city keys), declared in the ORM through
  `models.common.trigram_index`. Measured on 20 000 synthetic prospects: p95 39.8 ms in the service, 50–57 ms through
  HTTP; 208.9 ms without index; the first `label_key`-based design had p95 232 ms (2-letter queries folded every
  name). B-tree `text_pattern_ops` rejected (starts-with only). Production must allow `pg_trgm` (documented like
  `unaccent`: ADR-0017, runbook, decision I-124).
- **Shell UI** (`src/shell/GlobalSearch.tsx`, `global-search.css`, `src/api/search.ts`): header field « Rechercher un
  prospect, une entreprise, un SIREN… », Ctrl+K/⌘K anywhere and `/` outside text fields (ignored while a modal dialog
  is open), 200 ms debounce, one TanStack Query entry per query with its AbortSignal (a late answer is never shown;
  previous results stay dimmed and inert while a newer query runs), WAI-ARIA combobox + listbox of named groups, ↑/↓
  wrap, Enter opens, Shift+Enter or a row button opens the Database Explorer row, Esc closes then clears, Tab closes;
  2-character hint, no result, error + *Réessayer*, spinner, polite result count. A prospect opens
  `/prospection?prospect=<id>` — since the merge, the Task 15 Prospect editor; a company `useCompanyEditor(id)`; an
  establishment its company. New `recordHref` (`explorerView.ts`) and `MapPinIcon`.
- **Docs**: new `doc/features/global-search.md`, ADR-0017 (amendment notes in ADR-0002 and ADR-0005), interface spec,
  design system, data model, database explorer, prospection KPIs, prospect editor (entry points), runbook
  (`pg_trgm`, global search), testing strategy, decision log **I-120 … I-129**.

### Files
Backend: `app/services/search.py`, `app/api/routes/search.py`, `app/api/router.py`, `app/models/common.py`,
`app/models/prospects.py`, `app/models/companies.py`, `app/services/prospection/query.py` (`phone_needle` public),
`migrations/versions/0007_search_indexes.py`; tests `test_search.py`, `test_search_api.py`,
`test_search_performance.py`, `tests/builders.py` (`statements` helper moved there), `test_prospection.py`,
`test_home.py`. Frontend: `src/shell/GlobalSearch.tsx` (+ `.test.tsx`, `global-search.css`), `src/shell/AppShell.tsx`,
`src/api/search.ts`, `src/test/searchApi.ts`, `src/database/explorerView.ts`, `src/ui/icons.tsx`, `e2e/search.spec.ts`,
`e2e/auth.spec.ts`.

### Tests run (after merging `claude` @ `16a1126`)
`VIPER_E2E_DATABASE_URL=…/viper_wt2_e2e VIPER_E2E_WEB_PORT=5186 VIPER_E2E_API_PORT=8146 python scripts/verify.py --e2e`
→ privacy guard OK, ruff/format/mypy clean, **pytest 921 passed, 2 skipped** (private), eslint/tsc clean, **vitest 581
passed**, vite build OK, **Playwright 73 passed**. Search p95 in `test_search_performance.py` (20 000 prospects,
HTTP): 50–57 ms over three runs (budget 150 ms). Screenshots dark/light at 1440×900 of the open results (own tagged
rows; synthetic « Sophie Test » for the *Ne pas contacter* badge) reviewed — a role repeated by the exact title is now
shown once — and copied to the session scratchpad `task17-screenshots/`.

A first `--e2e` run after the merge failed only on Task 14's `test_prospection_performance.py` (counters 17 s, Home
308 s; the whole pytest step took 487 s instead of ≈ 90 s): the database container was loaded by another agent at the
time, and these tests' seed (`SELECT … FROM companies … OFFSET g % 200` per inserted row) is sensitive to dead tuples
left by earlier rolled-back tests. The same files passed alone (8–10 s) and together (50 s), and the full rerun above
passed without any change to them.

### Deviations / decisions
- Prospects are matched on their own names, e-mails and phones only — not through their company's name (unlike
  Prospection's `q`, I-95) — so a company query lists the company rather than its employees (I-121).
- Words shorter than 3 characters match only at a word start (I-122): performance (a 2-character substring has no
  trigram) and the expected behaviour of two typed letters.
- `search_key` is a new, cheaper folding function beside `label_key`, which stays the Settings uniqueness key.
- Group order follows the best match instead of a fixed order (a SIREN puts *Entreprises* first); fixed on ties.
- The performance test uses 2 000 prospects and 500 ms when `CI` is set; 20 000 and 150 ms locally (I-128).

### Open points / risks
- Figures come from the development machine (Docker Desktop on Windows) with another agent sharing the database; the
  local 150 ms budget keeps a ~3× margin, CI guards against order-of-magnitude regressions only.
- Prospection's `q` and the Database Explorer search keep their own, unindexed predicates; aligning them on
  `search_key` + trigrams would change their semantics, so it was not done here.
- `test_prospection_performance.py` (Task 14/16) can slow down under database load, see *Tests run*; not changed here.
