# 04 — Testing and Quality

## Global gates

- clean install/boot/migration;
- secure authentication required for application routes;
- source workbook never enters git/CI/public logs;
- schema invariants for IDs/FKs/primary contact aliases/taxonomies/contact suppression;
- provenance and audit generated on import/manual/Database Explorer writes;
- deterministic Excel parser tests;
- import preview flags incomplete/ambiguous/duplicate/legacy anomalies;
- round-trip import → manual update → export preserves useful information without recreating legacy semantic mistakes;
- permanent `do not contact` cannot be cleared by re-import;
- role mapping never silently creates a taxonomy value;
- Prospection counters and filters share one status semantics;
- Prospect editor supports create/edit, company changes, contact aliases, verification and Save & Next;
- Database Explorer tests cover read paging, filters, column state, long values, staged writes, delete confirmation, FK navigation and SQL read-only enforcement;
- Home aggregates are correct and only use real DB/manual-tracking data;
- accessibility: keyboard/focus/forms/context menus/contrast;
- desktop/laptop layouts use space well without dense clutter;
- no fake IProspect/IContact/email/Calendly data.

## Test infrastructure (Task 01)

- Backend: pytest against the real PostgreSQL `viper_test` database — schema reset + `alembic upgrade head` once per
  session, one rolled-back transaction per test (`db_session`, `client` fixtures in `backend/tests/conftest.py`);
  a migration test checks upgrade/downgrade and that migrations match the ORM models.
- Transactions: the `session_factory` fixture hands out sessions sharing the per-test transaction, where a commit
  is a savepoint release — so `unit_of_work` and the API client (which runs the real per-request `SessionDep`) can be
  tested for commit/rollback without leaking data (`test_transactions.py`).
- Schema (Task 03): `test_migrations.py` also compares CHECK constraint names and enum value lists with the ORM,
  requires the `updated_at` trigger on every timestamped table and an index behind every FK;
  `test_schema_constraints.py` exercises each invariant (uniqueness, partial indexes, CHECKs, deletion rules,
  append-only audit); service tests cover contactability, contact tracking, company change and the seed.
  Synthetic builders and the `rejected(session, "<constraint>")` helper live in `backend/tests/builders.py`.
- Frontend: Vitest + Testing Library (`renderApp(path)` / `stubFetchJson` helpers in `frontend/src/test/`);
  Playwright E2E in `frontend/e2e/`. Every component test runs within Vitest's default 5 s limit — no raised
  timeout: one behaviour per test, and long values entered with `fill` (`src/test/fill.ts`, one paste) rather than
  typed key by key, except where keystrokes are the behaviour (pickers, Enter/Ctrl+S, live validation). Measured with
  `npx vitest run --reporter=verbose`: slowest test ≈ 1.8 s, also while the backend suite runs (I-152).
- Authentication (Task 04): the backend `client` fixture is **signed in** as a synthetic pilot user (session cookie +
  CSRF header), `anonymous_client` is not — so feature-router tests need no auth plumbing. `test_auth.py` covers
  sign-in, identical answers for unknown email / wrong password, throttling, idle/absolute expiry, logout revocation,
  cookie flags, CSRF on every unsafe method, argon2id parameters and that neither password nor hash is serialized or
  logged; `test_route_protection.py` walks every route of the real app without a session (401 except the
  allowlist), proves a router added to `api_router` is protected automatically and that services receive the
  session's actor, not the payload's; `test_cli.py` covers `create-user`. Frontend: `renderApp(path, { session })`
  seeds a signed-in session by default (`'fetch'` asks the stubbed API; `stubApi({'METHOD /api/path': [status,
  body]})` routes replies); tests cover the login form, the guard redirect and deep link, global 401 handling,
  sign-out and the CSRF header.
- Audit and provenance (Task 05): `test_audit.py` (attribution from the session even with a forged payload actor,
  Database Explorer source, one event per changed row / no double logging, exact before values, many-to-many,
  secrets never stored, personal-value switch, nothing logged, newest-first ordering with id tie-break, append-only,
  rollback removes events, `GET /api/audit/recent`), `test_audit_payload.py` (JSON-safe values, diff, payload
  policy), `test_provenance.py` (sources, import batch lifecycle with the import actor, failed import after
  rollback); the existing contactability, company-change, contact-tracking, auth, CLI and seed tests assert their
  audit events; unattributed writes to audited tables fail and roll back, and every table must be classified audited
  or not. The `db_session` fixture binds `FIXTURE_ACTOR` (setup data is attributed, never silent); other test
  transactions use `attributed_unit_of_work(session_factory, FIXTURE_ACTOR)`. Helpers:
  `audit_events(session, action=, entity_type=)` (leaves out fixture writes) and `bind_operator(session)` in
  `tests/builders.py`.
- Full-stack E2E (Task 04): `npm run e2e` starts the real backend (uvicorn, port 8044, database `viper_e2e`) and a
  Vite dev server (port 5180) proxying to it; global setup rebuilds `viper_e2e` through the migrations and creates the
  E2E account with the real CLI and a random password. `auth.spec.ts` covers sign-in failure/success, reload, sign-out
  (server-side revocation), deep link and the cookie flags; the shell/design specs sign in through the API first.
  **Specs own their data; never assert global counts** (decisions I-80, I-81). All tests share the one E2E
  database, in a single Playwright project, `fullyParallel` with the default workers — every test alongside any
  other, in any order, repeatable (`--repeat-each`). Rules for every spec:
  - the synthetic dataset loaded by global setup is read-only: an edit of one of its rows may be staged, then must
    be cancelled or refused, never saved;
  - a test that writes creates its own rows (through the UI, an import of its own synthetic workbook, or the audited
    API with `createCompany` / `createReferent` from `e2e/data.ts`), with invented names carrying a run-unique suffix
    — `uniqueSuffix()` (and `syntheticSiren`/`syntheticSiret` for identifiers), or a random hex one where the app
    compares names by similarity (`import.spec.ts`) — and reaches them by a filter or a search, never by "the first
    row" or a name another test could also create;
  - exact counts and orders are asserted only on owned rows or on synthetic subsets no test changes, pinned by a
    marker of the synthetic dataset that created rows cannot carry (its `societeN.example.com` e-mail domains, the
    loader's audit events `actor_id = tests.e2e_data`) — a name filter alone is not enough (`Fret Import …` also
    contains « fret »); a whole-table count is compared with the API answer the page displays (the captured
    response), never with a number known in advance or read at another moment (a count read first and compared
    later still races with concurrent inserts);
  - rows added by tests come after the synthetic ones in the default primary-key order (UUIDv7), so the first
    synthetic rows of a page stay in place.
- Design system (Task 02): `src/theme/tokens.test.ts` parses `tokens.css` and asserts WCAG contrast of the key
  token pairs in both themes (text ≥ 4.5:1, focus/field boundaries ≥ 3:1) and that no raw colour literal exists
  outside the token file; `src/brand/assets.test.ts` decodes the six logo PNGs (RGBA, transparent edge, real
  artwork); primitives have accessibility tests (labels, descriptions, `aria-invalid`, dialog focus trap / Esc /
  focus restore / focus kept when the focused control is disabled or removed, badges never colour-only). `e2e/design.spec.ts` renders the shell in dark and light at 1440×900,
  checks persistence, logo transparency on a canvas, Inter loading, favicons and no overflow at 1280 px.
- Database Explorer staged editing and SQL console (Tasks 12/13): `test_explorer_writes.py`,
  `test_explorer_editability.py` (policy, change sets, French errors, delete diagnostics, audit) and
  `test_explorer_sql.py` (reader role and grants == exposure policy, security regression suite on raw reader
  connections and through the endpoint); `staging.test.ts`, `editing.test.ts`, `TableEditing.test.tsx`,
  `SqlConsole.test.tsx`; Playwright `database-edit.spec.ts`, `database-sql.spec.ts` — details in
  `doc/features/database-explorer.md`.
- Database Explorer (Task 11): `test_explorer_policy.py` (every ORM table classified; `users` / `user_sessions`
  never listed, readable or disclosed as FK targets/references; 401 without a session; unexposed/unknown/injected
  table names → 404 on every endpoint, hidden/masked columns never returned, searched, filtered, sorted or
  exported), `test_explorer_metadata.py`, `test_explorer_reads.py` (paging, multi-sort, search escaping, every
  operator per kind, type validation, AST limits, SQL-injection payloads as plain values, truncation/records, GET-only
  API), `test_explorer_export.py` (CSV format, formula neutralization), `test_explorer_performance.py` (50k synthetic
  rows: filtered, sorted deep page < 2 s; streamed export). Frontend: column-state reducer/persistence, URL view
  state, filter building, context-menu rules, FK links (`src/database/*.test.ts`), page-level component tests with a
  routed fetch stub (`stubApi`), `Menu`/`Popover` accessibility. Playwright `e2e/database.spec.ts` runs against the
  synthetic dataset loaded by the E2E global setup (`python -m tests.e2e_data` into `viper_e2e`; table pick, sort, filter, search, value viewer, FK hop
  and back, keyboard grid + context menu, no page overflow at 1280 px, screenshots in both themes); the navigation
  entry point is `e2e/helpers.ts` (`openDatabase`), where the login step goes once authentication exists.
- Company editor (Task 07): `test_companies.py` / `test_companies_api.py` (identifier rules, uniqueness naming the
  holder, establishments and primary switching, deletion refusal, search, similar companies, audit, 401/403),
  `src/companies/*.test.ts(x)` against the in-memory `src/test/companiesApi.ts`, Playwright `e2e/companies.spec.ts`
  with editor screenshots in both themes — details in `doc/features/company-editor.md`.
- Home (Task 16): `test_home.py` / `test_home_api.py` (every count equals the Prospection counter, monthly first
  contact / first appointment from the status history with imports excluded and Paris month boundaries, next-action
  groups and order, recent edits without values, 9 statements whatever the size), `src/home/*.test.ts(x)`, Playwright
  `e2e/home.spec.ts` (figures compared with the captured `/api/home` answer, drill-down checked on its own imported
  people) — details in `doc/features/home-dashboard.md`.
- Exploitation (Task 18): `src/exploitation/ExploitationPage.test.tsx` (navigation state, heading structure, coming-soon
  copy, and no button/link/control/list/table/figure/digit in the page) and `e2e/exploitation.spec.ts` (same smoke
  against the real stack, screenshots in both themes).
- Excel import engine (Task 08): synthetic workbooks generated in memory by
  `tests/fixtures/synthetic/legacy_workbook.py` (the 24-column historical layout, an `actualité` sheet, one row per
  compatibility case below, a fake reference snapshot). `test_import_workbook.py` (XLSX typed values, cached values
  not formulas, merged cells, CSV UTF-8/UTF-16/Windows-1252, delimiter sniffing, quoted fields, size/row/column and
  zip-bomb limits, encrypted/legacy/corrupt files), `test_import_layout.py` (sheet fingerprint, skip notices,
  folded headers, repeated `A contacter`, unknown/duplicate/unnamed/missing columns, user overrides),
  `test_import_normalize.py` and `test_import_matching.py` (every normalizer and anomaly code),
  `test_import_dedup.py` (in-file and existing duplicates, company candidates, do-not-contact blocking),
  `test_import_preview.py` (every compatibility case end to end, determinism with a reordered reference, run with
  sockets disabled, no database import in engine modules, JSON round trip, CSV and merged-cell flows, catalogue
  documented, and a seeded property test that every non-empty cell is mapped or preserved),
  `test_import_reference_loader.py` (snapshot from the real test database, SELECT-only). The private smoke
  `test_import_private_workbook.py` (marker `private`) is skipped unless `VIPER_PRIVATE_WORKBOOK` is set and prints
  counts per diagnostic code only.
- Excel export (Task 10): `test_excel_export.py` (real test database: sheets and headers equal the specification,
  frozen header, autofilter, widths; typed dates in Europe/Paris, text phones/SIREN/postal codes with leading zeros;
  company/person ordering and companies without prospects; round trip synthetic import → service and explorer edits
  → API download with the corrected semantics, complete aliases and every legacy value; byte-identical exports;
  formula-free cells with `quotePrefix`; audited attachment with counts only; 401; 3 000 synthetic prospects in
  < 45 s); `test_export_explorer_statistics.py` (20 000 prospects in the three planner states: the export's reads in
  ≤ 20 statements and < 2 s of database time, explorer deep page and table list < 2 s — I-155). Frontend: `ExportWorkbookButton.test.tsx` (progress, file name, fallback name, French error and retry,
  presence in both headers), `client.test.ts` (`apiDownload`). Playwright `e2e/export.spec.ts` downloads the workbook
  and reads its zip entries with Node's zlib (sheet names, a company the test created).
- Excel import review and commit (Task 09): `test_import_commit.py` (real test database: default commit with
  normalized entities, provenance, row metadata and import-actor audit; defaults never apply suggestions nor invent a
  year; grouped role mapping; explicit role/category creation audited as the user; referent/civility/week/inactive
  decisions and week 53; do-not-contact never recreated nor reactivated; attach/merge/exclude and merge rules;
  corrections re-analysed with the original kept; lossless row metadata; stale file/preview; re-import
  acknowledgement; mid-commit failure rolled back with a failed batch), `test_imports_api.py` (401/403, upload bounds
  before and after parsing, refusals without echoed values, commit/history/detail, failed batch persisted). Frontend:
  `src/imports/importPlan.test.ts`, `importFlow.test.ts` (state machine), `ImportPage.test.tsx` (flow, grouped
  mapping, exclusion, correction, commit summary, opposition, re-import, stale review). Playwright
  `e2e/import.spec.ts` (synthetic workbook generated in memory, resolve, exclude, commit, history, explorer, both
  themes' screenshots). Private `test_import_private_commit.py` commits the real workbook inside the rolled-back test
  transaction and prints aggregates only.
- Prospection (Task 14): `test_prospection.py` (expected members of every segment on one synthetic person per edge
  case, search, filters, counters == list totals on random bases, paging per sort, statement counts),
  `test_prospection_api.py`, `test_prospection_performance.py` (20 000 prospects; counters, deep page and Home in
  three planner states — without statistics, after a concurrent VACUUM, analyzed — ADR-0019); `src/prospection/*.test.ts(x)`
  against `src/test/prospectionApi.ts`; Playwright `e2e/prospection.spec.ts` creates its people through the import API
  (`importProspects`, `e2e/data.ts`) and narrows to their unique tag — details in `doc/features/prospection-kpis.md`.
- Prospect editor (Task 15): `test_prospect_editor.py` (service: every save step, verification action, alias rule,
  company change, tracking, opposition, stale version, deletion and the view model) and `test_prospects_api.py`
  (401/403, attribution, contactability refused in the save, a failing alias rolling back the whole save, refusal
  codes, 409); `src/prospects/*.test.ts(x)` against `src/test/prospectsApi.ts` with the editor rendered alone
  (`src/test/renderProspectEditor.tsx`, a fake queue) — interaction tests kept short, one behaviour each, so the 5 s
  Vitest limit holds under a parallel run; Playwright `e2e/prospect-editor.spec.ts` imports or creates its own people
  and narrows Prospection to their tag — details in `doc/features/prospect-editor.md`.
- Global search (Task 17): `test_search.py` (matching per field, accents/case, word starts, ranking, limits, badges,
  targets, 3 statements, literal wildcards), `test_search_api.py`, `test_search_performance.py` (20 000 prospects and
  p95 < 150 ms locally; with `CI` set 2 000 prospects and 500 ms); `src/shell/GlobalSearch.test.tsx` (debounce, late
  answers, keyboard, shortcuts, states); Playwright `e2e/search.spec.ts` on the test's own tagged rows — details in
  `doc/features/global-search.md`.
- History and provenance (Task 19): `test_history.py` (formatter per kind of event — manual edit, import creation,
  company change, alias add / primary switch / verification / deactivation / removal, tracking stage, opposition set
  and lifted with reasons, explorer edit, command-line creation, company fields/categories/establishments; an `agent`
  actor in the history and on Home; grouping by save and by time without a request id; cursor pages that never cut a
  save; values as stored under a masked policy, secrets/masked/structured values never shown; every audited column
  labelled or deliberately hidden), `test_history_api.py` (401, bounds, an editor save read back as one entry by the
  signed-in user, opposition reason, company pages); `src/history/*.test.ts(x)`; Playwright `e2e/history.spec.ts`
  (own imported person and company; Home's feed keeps only the 8 latest saves of the shared base, so the spec reads
  `/api/home` right after its save, requires its save there as one entry, and has the Home page render that captured
  answer — I-153) — details in `doc/architecture/audit-and-provenance.md`.
- Privacy: `scripts/check_private_data.py` in CI; synthetic fixtures only under `*/tests/fixtures/synthetic/`.
- Commands: `doc/process/runbook-local-dev.md`.

## Legacy workbook compatibility cases

Synthetic committed fixtures must cover:
- malformed/variant civilities (`M.`, `MR`, `MME.`, `0` style cases);
- legacy referent markers (`xxx`, `?`) and non-referent garbage;
- `S37/S39` without year and non-week legacy values such as `retraité`;
- unknown/invalid category value;
- unknown role/title;
- duplicate email and company name variant;
- multiple emails/phones and primary selection;
- historical stage conflicts even though the real workbook currently has those columns empty;
- unknown columns/row metadata preservation;
- permanent do-not-contact merge behavior;
- extra workbook sheet skipped with explicit notice.

## Visual quality

Use Neon Command for palette, density, surfaces, typography and accent behavior only. Do **not** copy the cyber-security content, threat vocabulary, world map, or the snake logo shown on that moodboard. Product iconography must use the accepted geometric VIPER mark family.
