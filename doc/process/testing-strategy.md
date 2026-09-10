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
  Playwright E2E in `frontend/e2e/`.
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
- Design system (Task 02): `src/theme/tokens.test.ts` parses `tokens.css` and asserts WCAG contrast of the key
  token pairs in both themes (text ≥ 4.5:1, focus/field boundaries ≥ 3:1) and that no raw colour literal exists
  outside the token file; `src/brand/assets.test.ts` decodes the six logo PNGs (RGBA, transparent edge, real
  artwork); primitives have accessibility tests (labels, descriptions, `aria-invalid`, dialog focus trap / Esc /
  focus restore, badges never colour-only). `e2e/design.spec.ts` renders the shell in dark and light at 1440×900,
  checks persistence, logo transparency on a canvas, Inter loading, favicons and no overflow at 1280 px.
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
