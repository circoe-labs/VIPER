# Agent brief — rules for every implementation slice

You are a sub-agent implementing **one slice** (one handoff task) of VIPER V1. An orchestrator reviews your
work, may reject it, and will send you back to fix it. Optimise for correctness, coherence with the existing code
and honest reporting — not for volume.

## Paths

- Repository: `C:\Projects\VIPER` — branch **`claude`** (never commit to `main`, **never push**).
- Handoff (frozen reference): `tasks/viper_v1_implementation_handoff_reviewed/` — read `README.md`,
  `tasks/TODO.md`, your `tasks/NN-*/TASK.md` and the docs it references.
- Living docs: `doc/` — see `doc/README.md`. Specs in `doc/` supersede the handoff copies when they differ.
- Visual assets: `tasks/viper_v1_implementation_handoff_reviewed/visuals/`.

## Privacy — the GitHub repo is PUBLIC

- `tasks/**/sources/` (incl. `BASE_CLIENT.xlsx`) is git-ignored and **private**. Never `git add -f` it, never copy
  it elsewhere in the repo, never paste its rows/names/emails/phones into code, tests, docs, commit messages,
  snapshots or console output. When you must run code against it, print **aggregate counts and anomaly codes
  only**.
- Committed fixtures are **synthetic** and live under `backend/tests/fixtures/synthetic/` (or
  `frontend/tests/fixtures/synthetic/`). Invent obviously fake names/companies (e.g. `Transports Exemple SARL`,
  `jean.test@example.com`).
- Before each commit run `git status` and check that no private file is staged.

## Stack & environment

- Stack: see `doc/adr/0001-stack.md`. Summary: Python FastAPI + SQLAlchemy 2 + Alembic + PostgreSQL 16 backend in
  `backend/`; React + TypeScript + Vite frontend in `frontend/`; pytest, Vitest, Playwright. Setup and every
  command: `doc/process/runbook-local-dev.md`; all gates at once: `python scripts/verify.py [--e2e]`.
- Machine: Windows 11. Shells: PowerShell 5.1 and Git Bash. Node 24 / npm 12, Python 3.14, Docker Desktop.
- Local Postgres runs in Docker on host port **5442** (5432 is used by another project). Do not stop or touch
  other projects' containers.
- Long-running servers (uvicorn, vite) must be started in the background and **stopped** before you finish.

## Coding guidelines

(The handoff asks for `/caveman` and `/coding-guideline` skills from `~/ai/skills/`; they are not installed on this
machine, so these rules replace them.)

- Terse, readable code. No dead code, no speculative abstraction, no commented-out blocks, no TODO without a
  task number.
- Match existing structure, naming and idioms before introducing new ones. Read neighbouring code first.
- Code, identifiers, commit messages and technical docs in **English**; **all user-facing UI copy in French**
  (e.g. `Suivi de contact`, `Rôle`, `Enregistrer et suivant`, `Bientôt disponible`).
- Strict typing (mypy/pyright-friendly Python type hints; TypeScript `strict`).
- Respect service boundaries from `doc/architecture/overview.md`: UI → HTTP API → application services →
  repositories/ORM. UI never touches SQL; routers stay thin; domain services don't know Excel column names.
- Every mutation goes through a service that receives the server-side `ActorContext` and emits audit events
  (after Task 05 exists).
- No fake data, no mocked IProspect/IContact/email/Calendly features, no CRM overreach.
- Don't add dependencies casually; prefer the standard library and what is already installed. Pin versions.

## Tests (mandatory)

- Add tests for the behaviour you implement (unit + integration against the real Postgres test DB; component
  tests for UI; Playwright E2E for critical user flows when the slice is UI-facing).
- Before committing, run the **full** backend and frontend suites plus lint/typecheck/build and make them green.
  Never weaken, skip or delete a test to get green; if a test is wrong, say so and why.

## Documentation (mandatory)

- Update the `doc/` pages your slice touches (spec pages, feature pages). Record any significant technical choice
  as a new ADR in `doc/adr/` (`NNNN-short-title.md`: Context / Decision / Consequences / Alternatives).
- Any deviation from the handoff or a locked decision → add an entry to `doc/product/decision-log.md`
  (section *Implementation decisions*) with rationale. Never silently change a locked product decision — if one
  seems wrong, stop and report it instead.
- Append an `## Implementation report` section at the end of your task's `TASK.md` in the handoff folder: what
  was done, files, tests run + results, deviations, open points.

## Commit

- Commit your slice on `claude` (one or a few focused commits), message style `feat(task-NN): <summary>` /
  `fix(task-NN): …` / `docs(task-NN): …`, ending with:

  ```
  Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01SymvtrRTijtX8dTGaW2HZR
  ```
- Never push, never rewrite history, never use `--no-verify`.

## Final message to the orchestrator

Reply with: (1) summary of what was built, (2) key files, (3) exact commands run and their results (test counts),
(4) deviations/decisions taken, (5) known gaps or risks, (6) commit hashes. Be factual: if something is not done or
not verified, say so explicitly.
