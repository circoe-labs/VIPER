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
- Design system (Task 02): `src/theme/tokens.test.ts` parses `tokens.css` and asserts WCAG contrast of the key
  token pairs in both themes (text ≥ 4.5:1, focus/field boundaries ≥ 3:1) and that no raw colour literal exists
  outside the token file; `src/brand/assets.test.ts` decodes the six logo PNGs (RGBA, transparent edge, real
  artwork); primitives have accessibility tests (labels, descriptions, `aria-invalid`, dialog focus trap / Esc /
  focus restore, badges never colour-only). `e2e/design.spec.ts` renders the shell in dark and light at 1440×900,
  checks persistence, logo transparency on a canvas, Inter loading, favicons and no overflow at 1280 px.
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
