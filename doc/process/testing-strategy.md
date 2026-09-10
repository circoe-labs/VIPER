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
- Frontend: Vitest + Testing Library (`renderApp(path)` / `stubFetchJson` helpers in `frontend/src/test/`);
  Playwright E2E in `frontend/e2e/`.
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
