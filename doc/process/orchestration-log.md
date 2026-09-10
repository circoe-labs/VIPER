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
