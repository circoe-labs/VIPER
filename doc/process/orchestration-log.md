# Orchestration log

Chronological record of how VIPER V1 was implemented: which slice was dispatched, what the orchestrator's review
found, what was sent back for rework, and the verification evidence accepted. Task status itself lives in
`tasks/viper_v1_implementation_handoff_reviewed/tasks/TODO.md`.

## Operating model

- One sub-agent per handoff task (slice), dispatched sequentially in TODO order; each follows
  `doc/process/agent-brief.md`.
- After each slice the orchestrator reviews the diff for scope, coherence with docs/locked decisions, privacy and
  test quality, re-runs the test suites itself, and either accepts or sends the agent back with concrete findings.
- Milestone checks in a real browser (Claude in Chrome) for UI slices; final end-to-end verification before handoff.

## Entries

### Task 00 — Orchestration & safety (2026-09-10)

- Repo re-checked: `circoe-labs/VIPER` is **PUBLIC**, contains only `README.md` on `main`; work branch `claude`
  created locally.
- Handoff folder dropped by the user into `tasks/`; all handoff docs, task files and the functional source read.
- Private-data guardrail: `.gitignore` excludes `tasks/**/sources/`, all spreadsheets/CSV except synthetic fixture
  folders, `.env*`, `private/`. Verified with `git check-ignore` that `BASE_CLIENT.xlsx` and source docs are ignored.
- `doc/` living documentation created from handoff docs; orchestrator decisions I-01…I-07 recorded in
  `doc/product/decision-log.md`.
- Task plan reconciled with repo reality: no dependency contradictions found; next task = **01 foundation-stack**.

### Task 01 — Foundation stack (2026-09-10) — ACCEPTED

- Dispatched to one sub-agent; commit `5c701a3`.
- Review: layered backend (`api/services/repositories/models/db/core`), thin router, typed settings, Alembic baseline,
  test fixtures that refuse any DB not ending in `_test` and roll back per test; frontend shell with the five French
  sections and no fake data; CI with a privacy guard job; ADR-0001 + local-dev runbook.
- Orchestrator re-run: `python scripts/verify.py` → privacy guard OK, ruff/mypy OK, pytest 20 passed, eslint/tsc OK,
  vitest 8 passed, build OK. Playwright smoke reported green by the agent.
- Accepted deviations: `httpx2` test client (Starlette 1.6), TypeScript 6.0 (typescript-eslint constraint),
  decision I-08 (English URL paths, French labels; backend 8042 / Vite 5173).
- Watch-points carried forward: `/api/health` must stay public when Task 04 protects the API; CI never ran on GitHub
  (nothing pushed).
- Next: Tasks 02 (frontend-only, separate worktree `task-02-design`) and 03 (backend-only, main worktree) run in
  parallel because they touch disjoint code.

### Tasks 02 + 03 — Design system / Data schema (2026-09-10) — ACCEPTED

- Run in parallel: Task 02 in worktree branch `task-02-design` (frontend only), Task 03 on `claude` (backend only).
- **Task 03** (`ce5f2dd`): 16 tables, hand-written migration 0002, UUIDv7, CHECK-constrained value sets, partial unique
  indexes (one active primary email/phone/establishment), DB trigger guarding do-not-contact (no silent reset, no
  delete), append-only `audit_log`, drift tests covering CHECKs/triggers/FK indexes, idempotent taxonomy seed.
  - **Rework requested**: services called `session.commit()` themselves, which would make the atomic Prospect-editor
    save (Task 15), transactional import (Task 09) and staged Explorer writes (Task 12) impossible. Fixed in `4de6d59`:
    services flush, `unit_of_work` owns the transaction, one request = one transaction (decision I-17), atomicity
    tests added.
- **Task 02** (`e93ba46`, `e220f97`): semantic tokens in one file with a WCAG contrast test and a no-raw-colour
  guard, Inter self-hosted, dark default / light derivation, six optimised logos with alpha verified, `BrandLogo`,
  primitives (Button, fields, StatusBadge with glyph+text, Table, Modal/Drawer with focus trap), collapsible sidebar,
  dev-only showcase `/_dev/ui`. ADR renumbered 0003 to avoid a clash with Task 03's ADR-0002.
- Merge `52ba0b3` (decision-log conflict resolved by keeping both sides).
- Orchestrator verification: `python scripts/verify.py --e2e` → all gates green (pytest 75, vitest 179, Playwright 7).
  Claude in Chrome on the running app (backend 8042 + Vite 5173): shell renders in Neon Command, sidebar sticky full
  height, API status "connectée", badges carry icon + text.
- Open brand question for the product owner: logo neon is lime `#79FA03` while UI accent is Viper Green `#00E676`
  (I-21).
- Next wave in parallel: Task 04 (auth, `claude`) and Task 11 (Database Explorer read, worktree `task-11-explorer`),
  since Task 11 only depends on 02–03. Task 04 protects the whole API router so Task 11 routes are covered on merge.

### Task 04 — Authentication & actor (2026-09-10) — ACCEPTED

- Commit `4fbb0ae`. Server-side sessions (only SHA-256 of the token stored), argon2id (RFC 9106 low-memory),
  identical response/time for unknown user vs bad password, in-process throttling (documented single-instance limit),
  cookie HttpOnly + Secure (configurable) + SameSite=Strict scoped to `/api`, session-bound HMAC CSRF token required
  on unsafe methods, protected-by-default `api_router` + public allowlist pinned by a route-walk test, `CurrentActor`
  from the session only, CLI `create-user` (no default password), French login page + guard + 401 handling,
  full-stack Playwright on `viper_e2e`. ADR-0004, I-23..I-25.
- Review: no rework needed. Watch-point: throttle is per-process (fine for the single-instance pilot, ADR-0004).

### Task 05 — Audit & provenance core (2026-09-10) — ACCEPTED after rework

- Commit `da73bf8`: `audit.annotate` + a single `after_flush` writer (one event per changed row, same transaction),
  change capture from ORM history, centralized payload policy (secrets never, PII behind one switch — full in V1,
  I-27), `subject_id` so a prospect's history includes its channels/tracking/sources, DNC clear reason persisted
  (closes I-12 gap), provenance + import-batch helpers, `GET /api/audit/recent`. ADR-0006, I-26..I-30.
- **Rework requested**: unattributed writes to audited tables were silently skipped (fail-open). Future writers
  (CLI, jobs, agents, Explorer edits) must not be able to create untraced changes. Fixed in `9c60488`:
  `UnattributedMutationError`, exhaustive audited/not-audited table classification test, `attributed_unit_of_work`
  for non-HTTP code, fixtures bind an explicit test actor (I-31).
- Agent-reported gates: pytest 163, vitest 207, Playwright 12 — all green.

### Task 11 — Database Explorer read (2026-09-10) — ACCEPTED, integration in progress

- Commit `f578f13` on `task-11-explorer`: default-deny table exposure policy (exhaustive test), metadata incl. CHECK
  values and incoming references, typed filter AST compiled with bound params, multi-sort with PK tiebreak, escaped
  search, truncation + full-record endpoint, streamed CSV export (BOM, `;`, formula-injection guard), virtualized
  TanStack grid, pin/hide/reorder/resize persisted per table, context menu, FK navigation with URL state, structure
  drawer. ADR-0005, I-40..I-46. Screenshots reviewed by the orchestrator: DBeaver-grade ergonomics in Neon Command.
- Integration delegated to the Task 11 agent inside its worktree: merged `claude` with Task 04 (`382d7dc`: auth tables
  withheld from the explorer with tests, explorer routes protected, single E2E infrastructure), then Task 05.
