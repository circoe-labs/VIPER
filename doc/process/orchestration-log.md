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
