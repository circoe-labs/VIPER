# VIPER V1 — Final Implementation Report

## Summary

VIPER V1 is implemented end to end: a signed-in, single-user web application over a PostgreSQL database of
prospects (people) and their companies, maintained by hand with a light contact follow-up, and exchanging data with
the historical Excel workbook through a reviewed import and a normalized export. The five sections of the handoff
exist — **Accueil** (global dashboard with real figures and next actions), **Prospection** (counters that filter a
readable people list, a large Prospect editor with explicit verification and « Enregistrer et suivant », the
Entreprises list and Company editor, Excel import review and export), **Exploitation** (an honest « Bientôt
disponible »), **Base de données** (a DBeaver-like explorer with staged, audited writes and a read-only SQL console
enforced by PostgreSQL) and **Paramètres** (roles, activity categories, commercial segments, internal referents).
Every mutation is attributed server-side and audited; a « Ne pas contacter » opposition is durable and survives
re-imports; nothing fakes IProspect/IContact, e-mail or Calendly.

All 21 handoff tasks (00–20) are done; none is deferred. Task 20 fixed the six defects carried from earlier reviews
and six found by its own release checks — the Database Explorer's search failing on every table with an enum column,
a re-import gap for people known by one name part (including opposed ones), 422 refusals echoing submitted values, a
Windows-only CLI password problem, a contrast violation and a clipped picker value — added a security-header layer,
an accessibility smoke and a keyboard-only session test, and verified the twelve global acceptance gates (evidence
below). The private legacy workbook imports, re-imports and exports with every checked invariant holding —
aggregates only in this report.

What is **not** decided and not in the code: hosting, backups, retention/anonymization, the stale-verification
threshold, the meaning of two legacy columns and a brand colour question (see *Known limitations / open
questions*). The application has never been deployed and the GitHub CI has never run (nothing has been pushed; the
same gates run locally through `scripts/verify.py`).

## Repository / commit / branch

- Repository: `circoe-labs/VIPER` (public), local only — **nothing pushed** (I-07).
- Integration branch: `claude`; Task 20 on `task-20-hardening`, based on `claude` @ `35b0074` (Tasks 00–19 and
  their fixes). Final Task 20 commit: see the implementation report appended to
  `tasks/viper_v1_implementation_handoff_reviewed/tasks/20-hardening/TASK.md`.
- Task 20 commits: carried fixes `b58fe16` (stale responses), `5365d31` (SQL reader provisioning lock), `382a6bd`
  (Vitest timeouts), `3d5fdcf` (history E2E), `7a065f7` (explorer header focus), `0b34075` (export statistics);
  release-check fixes `a1da317` (import dedup), `d59e35c` (422 echo), `a6b04f4` (CLI BOM), `52833b2` (combobox
  ellipsis), `d0d08bd` (explorer search on enum columns), `aa8f582` and `ac7d561` (E2E robustness); additions `d931f52`
  (security headers), `2558ed6` (axe smoke, NULL marker contrast), `a949c48` (keyboard session); documentation
  `eeb0123` and the final `docs(task-20)` commit.

## Completed tasks

| # | Task | Outcome (decisions) |
|---|---|---|
| 00 | Orchestration & safety | Repo public → `tasks/**/sources/` and every spreadsheet git-ignored, privacy guard in CI, living docs in `doc/` (I-01…I-07). |
| 01 | Foundation stack | FastAPI/SQLAlchemy/Alembic/PostgreSQL 16 + React/TypeScript/Vite, layered backend, CI, `scripts/verify.py` (ADR-0001, I-08). |
| 02 | Design system & brand | Neon Command tokens with a WCAG contrast test, dark default / light derivation, Inter self-hosted, six logo assets through `BrandLogo`, accessible primitives (ADR-0003, I-20…I-22). |
| 03 | Data schema | 16 domain tables, UUIDv7, CHECK-constrained value sets, partial unique indexes, do-not-contact trigger, append-only audit log (ADR-0002, I-09…I-17). |
| 04 | Authentication | Server-side sessions, argon2id, HttpOnly/Secure/SameSite=Strict cookie, session-bound CSRF, throttling, protected-by-default router, CLI account (ADR-0004, I-23…I-25). |
| 05 | Audit & provenance | `audit.annotate` + one flush hook, fail-closed attribution, payload policy, provenance and import batches (ADR-0006, I-26…I-31). |
| 06 | Settings | Taxonomies and referents, accent/case-insensitive uniqueness in the database, delete-only-if-unused, inline creation pickers (ADR-0009, I-32…I-36). |
| 07 | Company editor | SIREN/SIRET rules, establishments with one primary, similar-company warnings, Entreprises page under Prospection (I-37…I-39, I-70, I-71). |
| 08 | Import engine | Pure, deterministic preview, 71 diagnostic codes, lossless legacy metadata, dedup candidates, opposition blocking (ADR-0007, I-50…I-59). |
| 09 | Import review & commit | Stateless review, grouped decisions, merge rules, one-transaction commit with failure record (ADR-0012, I-72…I-79). |
| 10 | Excel export | One specification module, seven sheets, typed and formula-free, deterministic (ADR-0013, I-83…I-89). |
| 11 | Explorer (read) | Default-deny exposure, typed filters, virtualized grid, FK navigation, CSV export (ADR-0005, I-40…I-46). |
| 12 | Explorer (staged edits) | Per-table change sets, editability policy, optimistic concurrency, delete diagnostics (ADR-0008, I-60…I-66). |
| 13 | Explorer (SQL) | Dedicated read-only role with column grants from the policy, attack suite, hashed audit (ADR-0011, I-67…I-69). |
| 14 | Prospection | Canonical segments: counter == list, people cards, URL state, queue for Save & Next (ADR-0014, I-90…I-98). |
| 15 | Prospect editor | Atomic save, explicit verification actions, aliases, company change, opposition with reason (ADR-0015, I-100…I-109). |
| 16 | Home | Same segments as Prospection, monthly progress from the status history, next actions, recent imports and edits (I-110…I-117). |
| 17 | Global search | Ctrl+K search over prospects/companies/establishments, trigram indexes, p95 < 150 ms (ADR-0017, I-120…I-129). |
| 18 | Exploitation | « Bientôt disponible », no control or figure (tested). |
| 19 | History & provenance UI | One formatter for editor histories and Home's feed, values only inside editors (ADR-0018, I-130…I-137). |
| — | Home performance fix | Whole-base statements planned without nested loops/JIT (ADR-0019, I-140, I-141). |
| 20 | Hardening & report | This report; decisions I-150…I-161. |

## Deferred tasks and rationale

None. Task 17 (global search), the only task the handoff allowed to defer, was delivered.

## Architecture implemented

- **Layers** (`doc/architecture/overview.md`): React SPA → `/api/*` (thin FastAPI routers) → application services
  (business rules; flush, never commit) → repositories/ORM → PostgreSQL. One request = one transaction
  (`SessionDep`); CLI and jobs use `unit_of_work` / `attributed_unit_of_work` (I-17).
- **Security boundary**: every route behind `api_router`'s session + CSRF dependency except health and sign-in,
  pinned by route walks (401 anonymous; 403 without CSRF on every unsafe route). Actor identity only from the session.
  API responses carry `nosniff`, `X-Frame-Options: DENY`, CSP `frame-ancestors 'none'`, `no-referrer`, `no-store`
  (I-156); 422 refusals never echo submitted values (I-159).
- **Audit and provenance**: services annotate rows; one flush hook writes one event per changed audited row in the
  same transaction; unattributed writes fail (I-31); `audit_log` is append-only by trigger. Provenance rows record
  source, date, legal basis and actor for every prospect.
- **Import/export adapters**: legacy column names live only in `app/services/imports/fields.py` and
  `app/services/exports/spec.py`; the engine is a pure function of the file and a reference snapshot.
- **Database Explorer**: three separate paths — read (validated filter AST, bound parameters; enum columns searched
  as plain strings since I-161), staged writes (one change set through the ORM and the domain services), SQL (a
  PostgreSQL role that can only `SELECT` the exposed, unmasked columns, in a read-only transaction).
- **One semantics for the counts**: `app/services/prospection/segments.py` defines every segment once; Prospection
  counters, lists and Home cards use it, so a card always equals the list it opens.
- **Robust plans**: whole-base statements (counters, pages, Home groups, and since Task 20 the export's reads) run
  under `whole_base_plan` — no nested loops, no JIT — so a VACUUM racing a bulk import cannot make them quadratic
  (ADR-0019, I-155).
- **Frontend data**: TanStack Query only; every write refreshes through `refreshAfterWrite` (cancel, then invalidate),
  enforced by a lint rule (I-150).
- ADRs: 0001–0009, 0011–0015, 0017–0019 (0010 and 0016 unused numbers). No new ADR in Task 20: its choices extend
  existing ones and are recorded as I-150…I-161.

## Data model / migrations

- 18 tables: `companies`, `establishments`, `company_activity_categories`, `prospects`, `emails`, `phones`,
  `prospect_sources`, `contact_tracking`, `contact_tracking_status_history`, `roles`, `activity_categories`,
  `commercial_segments`, `internal_referents`, `import_batches`, `import_row_metadata`, `audit_log` (the 16 the
  explorer exposes) plus `users` and `user_sessions` (never exposed). Details: `doc/architecture/data-model.md`.
- Migrations `0001` baseline · `0002` core schema (constraints, triggers, do-not-contact guard, append-only audit) ·
  `0003` authentication · `0004` audit subject · `0005` `unaccent` + `label_key` uniqueness · `0006` import batch
  provenance · `0007` `pg_trgm` + search keys and indexes. Upgrade/downgrade round trip and model/migration drift
  (including CHECKs, triggers and FK indexes) are tested.
- Key invariants in the database: one active primary e-mail/phone/establishment, value sets by CHECK, taxonomy
  labels unique ignoring case/accents/spaces, do-not-contact not resettable except by the dedicated operation with a
  reason and an opposed prospect not deletable, audit log not updatable/deletable.
- Seed data is separate (`python -m app.seed`, idempotent suggestions). The SQL reader role is provisioned by
  `python -m app.cli provision-sql-reader`, serialized across the cluster since Task 20 (I-151).

## Excel import/export compatibility

The contract (`doc/features/excel-import-export.md`): import is preview → review → one-transaction commit; every
non-empty cell is mapped or preserved in legacy metadata; nothing is invented (no week year, no taxonomy value
without a decision); an opposed person is never recreated or reactivated; the export is normalized (Référent =
internal referent only, activity and verification separate, one « Suivi de contact » label, opposition distinct
from « Pas intéressé ») with every alias and every legacy value in their own sheets.

**Private legacy workbook, end to end (Task 20)** — run on the worktree's throwaway database, printed as counts and
booleans only, database reset afterwards; no exported file written to disk:

| Step | Result |
|---|---|
| Preview | 339 rows: 3 without remark, 325 with warnings, 11 in error (no name at all); 117 role groups, 12 category groups, 12 referent groups, 2 week codes without year, 1 civility group, 253 company keys |
| First commit (defaults + one week given the year 2025 + one role mapped to an existing role, one created, one category mapped, one referent group mapped to a synthetic referent; the 11 nameless rows excluded) | committed: 328 imported, 11 skipped → 247 companies, 324 prospects, 233 e-mails, 213 phones, 95 trackings, 328 provenance rows, 328 row traces; 52 trackings dated in 2025 from the explicit week year; 43 trackings name the mapped referent |
| Manual edits through the services (employment verified, company changed, opposition with a reason, second e-mail added, tracking set to « Contacté ») | all five applied; the company change cleared the employment verification and unverified the active channels (I-13); 5 audit events by the operator on those 5 prospects |
| Acknowledged re-import of the same file (defaults) | default resolutions: 326 attach, 1 create, 1 exclude (the row blocked by the opposition), plus the 11 nameless rows excluded; commit counts: `prospects_attached` 322, `prospects_created` 1 (one name part, no company, no e-mail: nothing to match on), `companies_linked` 247, `emails_added` 0, `phones_added` 0; companies unchanged (247) |
| Opposition after re-import | still `do_not_contact`, same reason, tracking untouched, its addresses held by one prospect only; 1 opposed prospect in the base |
| Losslessness | row traces == imported rows of both batches; the added alias kept |
| Export (in memory) | 7 sheets: Prospects 325 rows × 38 columns, Entreprises 247, Établissements 0 (the file has no address), E-mails 234, Téléphones 213, Provenance 655, Données d'origine 2 286; every sheet equals the database; legacy values exported 2 286 == stored 2 286; 0 formula cells; 42 non-empty Référent cells, all internal referents (no legacy marker); 1 « Ne pas contacter = Oui » row == 1 in the database, with its reason; no opposition wording in « Suivi de contact » |

Before the Task 20 fix I-157, the same re-import created 12 duplicate prospects (rows with one name part and no
e-mail were never matched) — a gap that could also have recreated an opposed person as contactable.

Performance on 20 000 synthetic prospects: the export takes ≈ 21 s over HTTP in every planner state (Python and
openpyxl; database reads ≈ 0.25 s in 16 statements); a V1-size base (hundreds to a few thousand rows) exports in a
few seconds.

## UX delivered

- **Accueil**: base health (prospects, companies, activity, opposition), verification and e-mail quality, contact
  activity (to contact, due, contacted, no response, responses, appointments), lightweight commercial stages, monthly
  progress against informative targets (100 contacts / 10 appointments), next actions (appointments within a week,
  due contacts, answers without appointment), recent imports and value-free recent edits. Every card opens its
  Prospection segment.
- **Prospection**: 16 counters as toggle filters, search (name, company, e-mail, phone), filters and sorts in the URL,
  one readable card per person; the Prospect editor drawer (identity, employment, explicit verification « Vérifié
  aujourd’hui » / date, e-mails and phones with primary/former/invalid, contact tracking in business days, opposition
  with reason, provenance, history), warning treatments with icon + text for imported/unverified values,
  company-change banner, dirty bar, Ctrl+S, Ctrl+Entrée = « Enregistrer et suivant » through the list's queue.
- **Entreprises** (Prospection sub-page) and the Company editor drawer; **import** page (file → sheet → review with
  grouped decisions, row detail, corrections, duplicates, preserved values → confirmation → result, history);
  **export** button.
- **Base de données**: table rail, virtualized grid with sort/filter/search/pin/hide/resize/reorder, value viewer,
  FK hops with « Retour », context menu, staged edits/inserts/deletes with diagnostics, CSV export, structure drawer,
  read-only SQL console. Since Task 20 the header row is one tab stop with keyboard actions (I-154).
- **Paramètres**: four sections as tabs, rename/deactivate/delete-if-unused with usage counts.
- **Global search** (Ctrl+K or `/`) opening editors or explorer rows.
- Accessibility: keyboard paths throughout (skip link, roving focus in grid and lists, dialogs with focus trap and
  restore, menus), labels and descriptions on every field, status never colour-only, contrast-tested tokens; Task 20
  added an axe-core smoke (10 pages/dialogs × 2 themes, 0 violations after one fix) and a keyboard-only session test.
- All copy in French; laptop viewports (1280×800, 1440×900) without horizontal overflow (tested).

## Neon Command / logo integration

- Neon Command is the visual language only (palette, density, surfaces, typography, selective neon); none of its
  cyber-security content or snake logo is used. Tokens in one file (`frontend/src/theme/tokens.css`) with a
  no-raw-colour guard and WCAG contrast assertions for both themes.
- Dark is the default and the authored identity; light is a conservative derivation, chosen explicitly and
  remembered (I-20).
- The accepted geometric VIPER mark family is used through `BrandLogo`: white mark/lockup on dark, black on light,
  the neon-accent variants reserved for accents; favicons follow the browser's colour scheme; alpha preserved
  (tested). Viper Green is the UI accent; success states use a distinct mint (I-22).
- Task 20 visual review: every main page (sign-in, Accueil, Prospection, Prospect editor, Entreprises + editor,
  import review, Database grid, SQL console, Paramètres, Exploitation) in both themes at 1440×900 and 1280×800 —
  consistent; fixes: the grid's NULL marker contrast and clipped combobox values.
- Open brand question: the logo artwork's neon is a lime (~`#79FA03`), not the UI's Viper Green (I-21).

## Tests and quality gates

### Commands run

- `python scripts/verify.py --e2e` (privacy guard, ruff, ruff format, mypy, pytest, ESLint, `tsc -b`, Vitest,
  production build, Playwright) — in the worktree and in a **fresh clone** of the branch on fresh databases.
- Playwright: 3 consecutive full runs at the default workers and three `--workers=12` runs.
- `npx vitest run --reporter=verbose` (durations; also with the backend suite running concurrently).
- `npm audit`, `pip-audit -r requirements.txt` / `-r requirements-dev.txt`.
- Private workbook scenario and the history leak scan (scratch scripts outside the repository; counts only).
- 20 000-prospect measurements in the three planner states (temporary test, not committed).

### Results

| Gate | Worktree (`task-20-hardening`, final code) | Fresh clone (`a6b04f4`, fresh databases) |
|---|---|---|
| Privacy guard | OK (553 tracked files) | OK |
| ruff check / format, mypy (strict) | clean, 189 files | clean |
| pytest (real PostgreSQL) | **966 passed**, 2 skipped (the private-workbook smokes) | 965 passed, 2 skipped |
| ESLint, `tsc -b` | clean | clean |
| Vitest | **610 passed** (51 files); slowest test 1.8 s, also under concurrent backend load | 610 passed |
| Production build | OK | OK |
| Playwright (full stack, `fullyParallel`) | **95 passed** in `verify.py --e2e`, then 95 + 95 on two more consecutive runs; `--workers=12`: 94/95 once (the import commit outlived a 5 s wait; test wait raised to 15 s, `ac7d561`), then 95 + 95 | 95 passed |
| `npm audit` (all dependencies) · `pip-audit` (runtime and dev requirements) | 0 vulnerabilities · no known vulnerability | — |
| axe-core WCAG 2.1 A/AA smoke | 20/20 (10 pages or dialogs × 2 themes), 0 violations of any impact after the NULL-marker fix | included in the 95 |

Suite growth in Task 20: pytest 948 → 966, Vitest 598 → 610, Playwright 74 → 95 (axe smoke 20, keyboard session 1).
An earlier series of runs (before `d0d08bd`) failed once in three: that failure revealed the explorer's search bug on
enum columns (I-161), which a weak E2E assertion had hidden.

**Carried defects** — each now has a test that fails on the old code: stale search answer after a save (page test
holding the search request; helper unit test) · provisioning race (two provisioning commands at once reproduced
« tuple concurrently updated »; 20 concurrent CLI processes on two databases then all succeeded) · Vitest raised
timeouts removed (15 s stop-gaps in two files) · history spec Home check (9 saves injected between save and Home
break the old check) · explorer header tab stops (20 → 1 for 5 columns) · export statistics (154 statements and
8–11 s of database time in the emptied state → 16 statements, ≈ 0.25 s in every state).

**Performance, 20 000 synthetic prospects, over HTTP** (three planner states: without statistics / emptied by a
concurrent VACUUM / analyzed):

| Home | Counters | Counters + search | Deep page (offset 5 000) | Explorer deep page | Explorer table list | Excel export |
|---|---|---|---|---|---|---|
| 204 / 164 / 144 ms | 95 / 81 / 75 ms | 195 / 188 / 172 ms | 127 / 133 / 116 ms | 38 / 37 / 36 ms | 22 / 28 / 17 ms | 21.1 / 21.4 / 21.2 s |

Global search: 140 searches over HTTP, p50 28 ms, p95 47 ms, max 62 ms.

**Security review**: route walk over all 44 routes (401 without a session except the two public ones; 403 without
CSRF on every unsafe route), SQL console attack suite green, API security headers (I-156), SQLAlchemy parameters
hidden from exception messages, 422 without submitted values (I-159), upload bounds before and after parsing
(existing tests), no secret in the tree or the history (only `backend/.env.example`; no key material in 91
commits), `.env*` ignored.

**Public-repository leak scan of the whole history** (91 commits of every ref, up to `ac7d561`; the final commit adds
only this task's documents): no spreadsheet/CSV ever added, nothing under `tasks/**/sources/`, no office or PDF file,
images only favicons/logos/handoff visuals. Content scan against
the private workbook's values computed in memory (241 e-mail addresses, 212 phone numbers, 302 full names, 169
company names): **0** matching lines for e-mails, phones, full names and company names; 4 distinct very common
French surnames appear alone in invented examples (no first name, e-mail or phone with them).

**Global acceptance gates** (`tasks/TODO.md`):

| # | Gate | Evidence |
|---|---|---|
| 1 | Secure authenticated app boots from a fresh clone and migrations run | Fresh clone on new databases following README + runbook only: install, `alembic upgrade head`, seed, `provision-sql-reader`, `create-user`, uvicorn → `/api/health` 200, anonymous `/api/home` 401, sign-in 200 with `HttpOnly; Secure; SameSite=Strict; Path=/api`; every gate green in the clone. Gaps found and fixed: README lacked seed/provisioning; `create-user --password-stdin` broke under Windows PowerShell (I-160). |
| 2 | Real workbook privately parsed/previewed without PII leakage | Private preview (339 rows, groups and codes as counts only); history leak scan 0 hits; nothing written to disk; throwaway database reset. |
| 3 | Correction, exclusion, dedup; no silent loss | Private run: 11 nameless rows excluded, row traces == imported rows, 2 286 legacy values exported == stored; re-import attaches instead of duplicating (after I-157); corrections and merges covered by `test_import_commit.py` and `import.spec.ts`. |
| 4 | Manual updates persist, audited and provenanced | Private run: 5 service edits → 5 operator audit events, company-change rule applied; editor/company/history specs; fail-closed audit (I-31). |
| 5 | Do-not-contact survives re-import, distinct from non-interest | Private re-import: the opposed person's row blocked and excluded by default, status/reason/tracking unchanged, no duplicate; export column « Ne pas contacter » with reason, no opposition wording in « Suivi de contact »; one-name-part gap closed (I-157). |
| 6 | Export reflects edits, no Référent/verification conflation | Private export: sheets == database, 42 Référent cells all internal referents (0 legacy markers), 0 formula cells; `test_excel_export.py` round trip. |
| 7 | Efficient Prospection: counters → filters, readable list, prefilled editor, Save & Next | `prospection.spec.ts`, `prospect-editor.spec.ts`, keyboard session (Ctrl+Entrée); 20 000 prospects: counters ≤ 95 ms, deep page ≤ 133 ms in every planner state. |
| 8 | Explorer useful and safe | Read/edit/SQL specs; attack suite; staged writes audited; search on enum tables fixed (I-161); one header tab stop (I-154); explorer page ≈ 37 ms at 20 000 prospects. |
| 9 | Home shows real activity and next actions | `home.spec.ts` compares the page with the captured `/api/home`; `test_home.py` (Home == Prospection counters); history spec on the captured answer (I-153); Home ≤ 204 ms at 20 000. |
| 10 | Exploitation has no fake functionality | `ExploitationPage.test.tsx` (no control/figure), `exploitation.spec.ts`, screenshots. |
| 11 | Neon Command and VIPER assets in dark/light | Token contrast test, asset alpha test, design spec, axe 20/20, review of 44 screenshots (every main page, both themes, 1440×900 and 1280×800; synthetic data; handed to the orchestrator, not committed — the feature specs regenerate theirs in `frontend/test-results/screenshots/`). |
| 12 | Tests/CI green; no private data in the public repo | All local gates green (above); privacy guard; history scan clean. **GitHub CI has never run** (nothing pushed). |

## Known limitations / open questions

- **Not deployed; CI never ran on GitHub** (nothing pushed). Production requirements and open ops decisions:
  `doc/process/runbook-production.md`.
- **Open product/ops/legal decisions** (`doc/product/open-questions.md`): hosting, backups, retention and
  anonymization (including whether audit events keep full contact values, I-27), log retention; the
  stale-verification threshold (#9, setting ready); the meaning of legacy « Mode de contact » and of the second
  « A contacter » (#4, #5, preserved raw); multiple contact cycles (#8); logo neon vs UI green (#12); rows known by
  one name part without company or e-mail are recreated by a re-import (#13, one row in the real file).
- **Single process, single user**: the sign-in throttle is in memory (reset on restart, per process); more users or
  processes need a shared store first (ADR-0004).
- **Excel export is synchronous** and whole-base (≈ 21 s at 20 000 prospects, a few seconds at V1 scale).
- **Monthly appointments** count stage changes into an appointment stage; an appointment recorded only as a date,
  without a stage change, is not in the monthly figure (I-113).
- **Logs**: PostgreSQL error details of an unexpected failure can quote a value; access logs carry query strings —
  production must disable or strip them (runbook-production.md).
- **Native date inputs** use the browser's own date format and placeholder (the headless Chromium of the
  screenshots shows `dd/mm/yyyy` even with a French locale).
- **Role picker on first load**: until the roles list has loaded once in the session, the Prospect editor's « Rôle »
  field shows its placeholder (with the clear button) for a person who has a role; the label appears when the list
  arrives, and the list is cached afterwards. Cosmetic, seen in the Task 20 screenshots, not changed at release.
- **E2E suite** assumes one shared database per run and parallel workers; tests own their data (I-81). At 16 workers
  the single-process backend times out some requests (no wrong data) — 10–12 workers is the tested range.

## Deviations from handoff

All recorded with rationale in `doc/product/decision-log.md`; the locked grill decisions are unchanged.

- Stack and conventions chosen by the implementation (I-01, ADR-0001); the `/caveman` and `/coding-guideline` skills
  replaced by `doc/process/agent-brief.md` (I-05); English URL paths with French labels (I-08).
- Transactions owned by callers, services flush (I-17); audit fails closed (I-31); contact values stored in full in
  audit behind one switch (I-27).
- Theme defaults to dark regardless of the OS (I-20); logo artwork used as delivered (I-21).
- Account management CLI-only, no default account (I-24); Entreprises and Import as Prospection sub-pages, no sixth
  navigation section (I-37, I-79).
- Stateless import review with fingerprint and digest checks (I-72); conservative defaults (I-74); referents never
  created from an import (I-76); a person with one name part matches only with the same company (I-157, amends I-59).
- Export: default column order (I-84, open question #6 narrowed), alias sheets (I-86, #7 resolved), seven sheets
  (I-87).
- Prospection semantics: « À contacter » includes untracked people, inactive people excluded from actionable queues
  (I-92); verification segments without an age threshold until product chooses one (I-91).
- Home: commercial counts = current stage (I-111); monthly contacts/appointments = first transition in the month,
  imports excluded (I-112, I-113).
- Search: prospects are not matched through their company's name (I-121).
- Whole-base statements planned without nested loops or JIT (I-140, I-155).
- Task 20 hardening: refresh-after-write convention (I-150), cluster-wide provisioning lock (I-151), no raised
  Vitest timeout (I-152), Home check on the captured answer (I-153), one header tab stop (I-154), security headers
  and hidden SQL parameters (I-156), axe smoke (I-158), no value echo in 422 (I-159), BOM-tolerant CLI (I-160),
  explorer search on enum columns (I-161).

## Follow-up recommendations

1. **Decide hosting, backups and retention** (runbook-production.md); then choose the audit personal-value policy
   (I-27) before real data accumulates, and test a restore (roles must be re-provisioned).
2. **Push and let CI run** once the owner approves: the same gates run locally, but the GitHub workflow has never
   executed.
3. **Validate a CSP for the SPA** on the production build (report-only first), with HSTS at the proxy.
4. Pick the **stale-verification threshold** (`VIPER_VERIFICATION_STALE_DAYS`) and settle the two legacy columns (#4,
   #5) with the operator, then map them.
5. Run the **first real import** with the operator: choose the year of the two week codes, review the 117 job-title
   groups, complete or exclude the rows with one name part.
6. Before more than one user: move the sign-in throttle to the database and revisit single-process assumptions.
7. If the base grows by an order of magnitude, move the Excel export to a background job and consider keyset paging
   in the explorer (I-42).
8. Keep the rules that made the suite reliable: specs own their data (I-81), writes refresh through
   `refreshAfterWrite` (I-150), whole-base reads under `whole_base_plan` (ADR-0019).
