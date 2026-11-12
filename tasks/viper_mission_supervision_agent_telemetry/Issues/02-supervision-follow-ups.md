# Mission supervision: small follow-ups (non-blocking)

Recorded by Slice 10 after the final review; none is a regression of this task.

1. **Vocabulary drift.** The shared `missions/vocabulary.ts` keeps the three historical wordings as they shipped:
   badges say « Validé / Rejeté », counts say « Acceptés / Refusés », the review dialog and Overview have their
   own wording. A product pass should pick one pair.
2. **Late log after submit** is refused with the generic `_claimed` message (« The claim is lost… »). Correct and
   non-fatal; a specific message would help agents (S4).
3. **Results `agent` filter** matches `submitted_by_id`; historical results without a token id cannot be filtered
   by agent (S5).
4. **Activité filters** are local state (not in the URL) and the session list covers the first 100 sessions (S7).
5. **Mobile.** The app shell sidebar is fixed and not responsive at 390 px (page-level horizontal scroll, S6).
6. **No retention purge** for `mission_agent_sessions` / `mission_agent_logs` (contract §7.3 deferred).
7. **UTC day buckets** in Statistiques can differ from the user's local day (stated in the UI).
8. **E2E database teardown.** `global-setup.ts` runs `alembic downgrade base`, which fails on a `viper_e2e` database
   that still holds mission tasks (`agent_tasks.thread_id` NOT NULL on downgrade). Drop and recreate the database
   between runs that create missions.
9. **Pre-existing red gates on `main`** (not touched): 8 backend tests (warehouse audit/trigger/FK index, explorer
   editability message of `ck_companies_services_allowed`, 20k-prospect planning time, `/api/auth/signup`
   route-protection allowlist), 13 frontend tests, 65 of the 114 Playwright specs (shell navigation, Prospection, Contacts, imports, companies... drifted from the UI), ruff/mypy/eslint findings in untouched files. The same 65 fail on `main`.
