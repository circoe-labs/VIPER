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
  withheld from the explorer with tests, explorer routes protected, single E2E infrastructure), then Task 05
  (`2786a2f`: E2E dataset loaded under an attributed unit of work). Merged into `claude` as `61ff0dc`.
- Orchestrator verification on `claude`: `verify.py --e2e` → pytest 245, vitest 274, Playwright 19, all green.

### Wave 06 ∥ 08 ∥ 12 (2026-09-10)

- Three agents in parallel: Task 06 on `claude`, Task 08 in worktree `task-08-import-core`, Task 12 in worktree
  `task-12-explorer-edit`, each with its own databases/ports. All three were interrupted by an API session limit
  (reset 19:00) and resumed from their uncommitted working trees without loss.
- **Task 06 — Settings — ACCEPTED** (`e6104ed`): taxonomy + referent services (rename keeps id and slug,
  delete-only-if-unused with usage counts, deactivate/reactivate), DB-enforced accent/case-insensitive uniqueness via
  `unaccent` + `label_key()` (migration 0005, ADR-0009), audited mutations, `/api/settings/*`, tabbed Settings page,
  reusable `TaxonomySelect` / `TaxonomyMultiSelect` / `ReferentSelect` with inline creation. I-32..I-36. Screenshots
  reviewed. Watch-point: production Postgres must allow the `unaccent` extension.
- **Task 08 — Import engine — ACCEPTED** (`452d609`, merged `claude`): pure deterministic `build_preview` (no DB,
  clock, randomness or network — enforced by tests), XLSX/CSV adapters with limits, header-fingerprint sheet
  detection, positional disambiguation of the duplicate `A contacter`, 71 diagnostic codes with French messages that
  never embed cell values, lossless legacy metadata (property test), dedup candidates, DNC blocking. ADR-0007,
  I-50..I-59.
  - Private compatibility smoke re-run by the orchestrator on `claude`: output is aggregate-only (339 rows,
    `actualité` skipped with notice, 3 duplicate-email groups, anomaly code counts) — matches the handoff profile.
- Orchestrator verification after merging 06 + 08: `verify.py --e2e` → pytest 506 (+1 private skipped), vitest 318,
  Playwright 26, all green.
- Next: Task 07 (+ trivial Task 18 as a separate commit) on `claude` while Task 12 finishes.

### Tasks 12 + 13 — Explorer staged edits / read-only SQL (2026-09-10) — ACCEPTED

- **Task 12** (`06f1743`, branch `task-12-explorer-edit`): centralized editability policy (read-only by default,
  French reasons), all-or-nothing change sets through the ORM (audited `database_explorer` + signed-in actor),
  optimistic concurrency on `updated_at`, domain rules reused (company change, tracking history), delete diagnostics
  listing blockers and cascades, DNC columns read-only, dirty-navigation guard. ADR-0008, I-60..I-66.
- **Task 13** (`ce992b6`, same branch, dispatched to the same agent because it knew the explorer code): the database
  is the security boundary — dedicated `viper_sql_reader` role with column-level SELECT grants derived from the
  exposure policy (test asserts grants == policy), read-only defaults and timeouts, one connection per query,
  server-side cursor with row cap, audit stores only SHA-256/length of the query (never the text). Attack suite
  (writable CTE, `set_config`, `COPY TO PROGRAM`, `pg_read_file`, hidden tables, `SET ROLE`…) all refused or harmless.
  Provisioning is an explicit CLI command (`provision-sql-reader`, re-run after migrations). ADR-0011, I-67..I-69.

### Tasks 07 + 18 — Company editor / Exploitation placeholder (2026-09-10) — ACCEPTED

- **Task 07** (`2dbb963`): CompanyService (SIREN/SIRET Luhn incl. La Poste rule, conflicts named, domain
  normalization, webmail domains refused, establishments with safe primary switching, delete refused with prospects),
  `/api/companies`, reusable `useCompanyEditor()` drawer, entry point `/prospection/companies` (I-37: no sixth nav
  section). I-37..I-39, I-70, I-71.
- **Task 18** (`1745514`): honest "Bientôt disponible" Exploitation page, tests assert no fake widgets.
- **Critique carried into the explorer integration**: `database.spec.ts` hard-coded global row counts, forcing a
  Playwright project-ordering workaround in Task 07. Tests must assert filtered/relative facts instead.
- Process change from here: all implementation agents work in worktrees; the main checkout is reserved for the
  orchestrator's merges and verification (avoids agents' `git add -A` picking up orchestrator edits and merges
  happening under a working agent).
- Next: Task 12/13 branch integrates `claude` (+ E2E decoupling, "Ouvrir dans l'éditeur" on companies rows);
  Task 09 (import review/commit) in worktree `task-09-import-review`.

### Integration of 12/13 and E2E flakiness (2026-09-10)

- Explorer branch integrated `claude` (`ce23fa5`), removed the Playwright ordering hack (`ed82ab4`, I-80) and added
  "Ouvrir dans l'éditeur" on companies rows (`19a5076`). Merged into `claude` as `d93da1c`.
- **Orchestrator verification found a regression**: under default parallel workers, `database.spec.ts` and
  `database-sql.spec.ts` still failed intermittently (expected 36 companies, got 37) — the "read count first" fix was
  still racy; the agent had validated with sequential runs only. Sent to a fresh agent (branch `fix-e2e-isolation`)
  with the rule "specs own their data; never assert global counts", proof required by repeated full-parallel runs.
  Same agent fixes the Drawer/Esc focus bug reported during integration (Esc stopped closing a drawer after a
  mouse-click save disabled the focused button).

### Infrastructure incident — Docker engine hang (2026-09-10)

- The Docker Desktop Linux engine hung (API 500s, Postgres on 5442 unreachable). The orchestrator restarted Docker
  Desktop; all containers stopped. Restarting other projects' containers was (rightly) outside this session's
  permissions and was left to the user; `viper-db-1` was restarted (same volume) and all 9 VIPER databases were intact.
  No data loss.

### Task 09 — Import review & transactional commit (2026-09-10) — ACCEPTED

- Commit `0e7c2e0`, merged as `b214be8`. Stateless review (ADR-0012): the browser re-sends the file; the server re-runs
  the deterministic engine and checks file fingerprint + preview digest (409 `file_changed` / `preview_outdated`);
  re-import of a committed fingerprint needs explicit acknowledgement. Typed decisions (grouped by raw value: roles,
  categories, referents, civilities, weeks with an explicit year, `retraité` confirmation; dedup link/create/attach/
  merge/exclude; required legal basis). Merge rules fill empty fields only; DNC prospects never touched. Commit in one
  transaction attributed to the import actor on behalf of the user; failures recorded as `failed` batches.
  Migration 0006. I-72..I-79. Screenshots reviewed ("À résoudre" grouped by raw value, row detail with preserved
  values).
- Private run (aggregates only, throwaway DB reset afterwards): 339 rows → 328 imported, 11 excluded (no name);
  324 prospects, 247 companies, 233 emails, 213 phones, 328 sources, 328 row-metadata rows; 0 tracking because the
  stage columns are empty and the two week codes need a year chosen by the user. Invariants held (no DNC touched,
  every row accounted for).
- Next wave: Task 10 (export, worktree `task-10-export`) ∥ Task 14 (Prospection, worktree `task-14-prospection`);
  the E2E-isolation fix continues in parallel.

### E2E isolation + Dialog/Combobox fixes (2026-09-11) — ACCEPTED

- Branch `fix-e2e-isolation` (`d76f326`, `8635cf9`, `32b34e2`, merge `7784f89`), merged as `3998d0d`. Playwright
  `fullyParallel: true`; `frontend/e2e/data.ts` (`uniqueSuffix`, synthetic SIREN/SIRET, `createCompany`,
  `createReferent`); every spec owns its data or asserts on marker-pinned synthetic subsets; I-81 amends I-80.
  Evidence: 6 consecutive full runs (10 workers), 2 runs at 12 workers, 3× `--repeat-each=3` batches — all green.
- Dialog keeps focus / handles Esc when the focused control is disabled or removed (tests fail on old code).
- Side fix accepted: the Combobox offered only "Créer « … »" while its list was loading, so Enter created
  near-duplicates; creation is now offered only after load (I-82).
- Carried to Task 20 (hardening): stale search response can overwrite the company list after a save under a slow
  server; `provision-sql-reader` can race across concurrent checkouts ("tuple concurrently updated") — add a lock;
  16-worker stress shows backend single-process timeouts (no wrong data).
- Orchestrator note: a first verification run on `claude` failed 12 import API tests — root cause was the
  orchestrator's own venv missing the new `python-multipart` dependency (not a code defect); fixed by re-installing.
  `CompanyEditor.test.tsx` timed out under concurrent load (tests ~4.9 s vs 5 s limit).

### Task 10 — Normalized Excel export (2026-09-11) — ACCEPTED

- Commit `783511a`, merged as `7c703df`. Single column spec (`app/services/exports/spec.py`), default order from the
  grill priority (Référent first … ids last), seven sheets (Prospects, Entreprises, Établissements, E-mails,
  Téléphones, Provenance, Données d'origine) so nothing is silently dropped; real dates, text-typed phones/SIREN,
  formula-injection guard shared with the explorer CSV (quote-prefix style, value unchanged), byte-identical output
  for identical data; `GET /api/exports/workbook` audited as `export.generated` (counts only); reusable
  `ExportWorkbookButton`. ADR-0013, I-83..I-89; open question #7 resolved, #6 narrowed.
- Private check (aggregates only, DB reset afterwards): Prospects 324 rows × 38 cols, 7 sheets, 1 145 legacy values
  exported == 1 145 stored, 0 formula cells, 0 legacy markers in Référent.
- The agent raised `CompanyEditor.test.tsx`'s timeout to 15 s after diagnosing that the timed-out test kept typing
  into following tests. Accepted as a stop-gap; splitting the long interaction tests is carried to Task 20.
- Orchestrator verification on `claude` @ `7c703df`: `verify.py --e2e` → pytest 755 (+2 private skipped), vitest 471,
  Playwright 52 — all green.

### Task 14 — Prospection workspace (2026-09-11) — ACCEPTED

- Commits `e2616c3`, `4dc64d1`, `165e78a`, `c165834`; merged as `d818cc4`. One canonical segments module
  (`app/services/prospection/segments.py`, ADR-0014) drives 16 counters (single aggregate query) and the list
  filter, so a counter always equals the list it opens; people-card list (not a spreadsheet), counters as filters
  with a non-colour active mark, URL state, keyboard navigation, open-editor/queue contract for Task 15
  (`?prospect=<id|new>`, `ProspectEditorContext`, `ProspectQueue.next()`), honest fallback (opens the row in the
  Database Explorer; "+ Ajouter" disabled until the editor exists). Stale threshold only if
  `VIPER_VERIFICATION_STALE_DAYS` is configured (open question #9 untouched). I-90..I-98.
- Screenshots reviewed (dark/light, 1440/1280). 20 000-prospect perf: counters ≈0.25 s, deep page ≈0.15 s.
- Orchestrator verification on `claude` @ `d818cc4`: pytest 813, vitest 503, Playwright 58 — all green.
- Next: Task 15 (Prospect editor, worktree `task-15-prospect-editor`) ∥ Task 16 (Home, worktree `task-16-home`).
  Parallelism capped at two agents after the Docker memory incident.

### Task 16 — Home dashboard (2026-09-11) — ACCEPTED after correction

- Commits `dcd1921`, `203b5f2`, `0637546`, `a669bd7`; merged as `8d95ef6`. `GET /api/home` (9 queries, ≈0.25 s on
  20 000 prospects) reusing the canonical segments (Home card == Prospection counter, tested), monthly progress over
  6 months in Europe/Paris with informative configurable targets (100/10), next actions (appointments ≤ 7 days, due
  contacts, responses without appointment), recent imports + grouped manual edits without field values. I-110..I-117.
  - "Appointments this month" = first entry into an appointment-or-later stage (not `appointment_at`, which is the
    meeting date); imported stages excluded from monthly figures.
- **Correction requested**: the agent documented a false limitation ("Database Explorer stage changes write no
  history"). The orchestrator checked `explorer/writes.py`: it routes through `save_contact_tracking`. Fixed in
  `a669bd7` with a test proving explorer changes count in the month; docs and I-113 corrected.
- Orchestrator verification after merge: pytest 839, vitest 522, Playwright 63/64 then 64/64 — flake identified by
  repeated runs: `auth.spec.ts` asserted `getByText('Pilote E2E')`, which Home's activity feed now also renders
  (strict-mode violation). Fix assigned as the first commit of Task 17.
- Next: Task 17 (global search, worktree `task-17-global-search`) while Task 15 continues.

### Task 15 — Prospect editor (2026-09-11) — ACCEPTED

- Commits `62fd2f5`, `f70b009`, `ad9cec6`; merged as `4eb510c`. One-request/one-transaction save composing domain
  operations (inline role at save time, `change_company`, aliases as full lists with two-step primary switching,
  tracking with history, manual provenance on create); verification is an explicit action
  (`keep`/`verified_now`/`verified_on`/`clear`), not an editable status; opposition only through a dedicated
  endpoint with a mandatory reason (the save rejects contactability fields); multi-table version → 409 on any
  concurrent change; delete refused for DNC. Drawer with the nine spec sections, warning/verified/stale treatments
  with icon + text, company-change banner, dirty bar, Save & Next over the Task 14 queue, Ctrl+S / Ctrl+Entrée /
  Échap. ADR-0015, I-100..I-109. Screenshots reviewed.
- Review note carried to Task 19: an empty "Rôle" field showed "Importé, à confirmer" (should be an actionable
  empty state).
- Orchestrator verification after merge: vitest 569, Playwright 68, lint/tsc/build OK; pytest 885/887 in the full
  run — the two 20k-prospect performance tests exceeded their budget only because the Task 17 agent was running its
  own 20k load tests on the same Postgres server at that moment (whole suite 8 min instead of ~1); re-run alone:
  both pass (10 s total). Not a regression; CI runs in isolation.
- Next: Task 19 (history/provenance UI, worktree `task-19-history`) while Task 17 continues.
