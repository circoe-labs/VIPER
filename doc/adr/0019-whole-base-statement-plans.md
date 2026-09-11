# ADR-0019 — Whole-base statements are planned without nested loops or JIT

- Status: accepted
- Date: 2026-09-11
- Deciders: Home performance fix (branch `fix-home-performance`), for orchestrator review
- Related: [ADR-0014](0014-canonical-prospect-segments.md) (segments over `join_segment_sources`),
  `doc/features/home-dashboard.md` (*Performance*), `doc/features/prospection-kpis.md`, decision log I-140, I-141,
  `backend/tests/test_prospection_performance.py`

## Context

After the Task 17 merge, `test_home_on_20k_prospects` took 250–310 s instead of ≈ 0.3 s — sometimes: about one run
in four on an idle machine, more under load. Nothing in Task 17 caused it. The cause is the planner statistics that
autovacuum leaves when it races the test.

1. The previous test rolls back its 20 000 seeded prospects, e-mails and trackings. They become dead rows, and
   autovacuum, which visits each database about once a minute, vacuums those tables.
2. If that VACUUM runs while the next test's seed is still uncommitted, it counts no live row. Rows being inserted
   by another transaction are not counted, and the pages cannot be truncated because the new rows are at the end of
   the table. It records `pg_class.reltuples = 0` with `relpages` in the hundreds.
3. The planner estimates a table's rows as `reltuples / relpages × current pages`. That gives 0, clamped to 1, for
   `prospects`, `emails`, `contact_tracking` and `companies`. Each join of `join_segment_sources` is then planned
   as a nested loop that does a full scan of the inner table's index for every outer row. It never uses the index as
   a lookup.

Observed live (`pg_stat_user_tables`): the failing run had an autovacuum of the four tables 5–13 s into the file, and
afterwards `reltuples = 0` with 656 pages. The orchestrator's `viper_test` showed the same pattern (two autovacuums
per table, one of them during the Home test). The passing databases showed one autovacuum per table, after the
tests. Reproduced deterministically by running `VACUUM` from a second connection between the seed and the call.
`EXPLAIN (ANALYZE, BUFFERS)` in that state:

| Statement | Time | Evidence |
|---|---|---|
| segment counters (`count_segments`, Home and Prospection) | 122.8 s | every node `rows=1`; *Rows Removed by Join Filter* 399 980 000 (primary e-mail) + 168 041 979 (tracking); 569 M buffer hits |
| Home *Contacts échus* group | 86.6 s | `companies` scanned 12.4 M times, `prospects` fully scanned 931 times |
| Home *Réponses sans rendez-vous* group | 185.9 s | `companies` scanned 26.6 M times |
| monthly progress, companies + stages, imports, recent edits | 1–15 ms | one table each — unaffected |

The same state at migration 0006, without the trigram indexes, fails the same way. 0007 only made the seed ≈ 10 %
slower, which slightly widens the race window. Every join already had its unique index (`uq_contact_tracking_prospect_id`,
`uq_emails_prospect_id_primary`, `pk_companies`), so no index is missing.

Production can reach this state. It happens when a VACUUM overlaps a bulk write into tables whose committed content
is (almost) empty. The typical case is a first import retried right after a failed one. The state lasts until
autoanalyze runs, about a minute after the commit. During that minute Home and Prospection would take tens of
seconds on a 5 000-row import.

A second finding came from the same measurements: **JIT**. The counters statement's estimated cost (≈ 330 000 with
statistics, ≈ 520 000 without, driven by the per-row `EXISTS` of `channels_reset`) is above `jit_above_cost` and
`jit_inline_above_cost`. LLVM compilation then costs ≈ 45 ms with statistics and ≈ 410 ms without, for a statement
that runs in ≈ 55 ms.

## Decision

1. **`app.db.session.whole_base_plan(session)`** wraps the statements that read every (filtered) prospect with its
   one-row sources: the segment counters (`prospection.query.count_segments`, hence Home's cards), the Prospection
   page and its total (`list_prospects`) and Home's three next-action groups (each counts its whole segment with
   `count(*) OVER ()` before keeping five). Inside the block, `enable_nestloop` and `jit` are `off`. They are set
   with transaction-local `set_config(…, true)` and reset to their defaults after the block, or reverted by the
   rollback on an error.
2. A hash or merge join reads each table once, whatever the estimates, and a nested loop never beats it on a
   whole-base read. The guard bounds these statements to linear time even when the planner thinks a table is empty.
   With correct statistics it is also faster: the planner's own choice was already hash joins, and JIT is gone.
3. Not guarded: single-row reads (`prospect_verification_state`), single-table aggregates (monthly progress,
   companies + stages), the audit feed, the global search (index lookups by design) and the Database Explorer.
4. No index and no migration.
5. `tests/test_prospection_performance.py` measures each service in the three planner states of a real base:
   without column statistics (right after a bulk load), emptied by a concurrent VACUUM (forced from a second
   connection), and analyzed. The budget applies to each state (I-141).

## Consequences

- On 20 000 prospects, service time before → after: Home 0.57 s → 0.17 s without statistics, catastrophic
  (> 250 s) → 0.18 s after the concurrent VACUUM, 0.19 s → 0.16 s analyzed. Over HTTP, the three states measure
  ≈ 185 / 155 / 135 ms (Home), ≈ 210 / 185 / 165 ms (counters with `q`) and ≈ 120 / 130 / 105 ms (deep page).
- The new performance test fails on the code before this decision. After the forced VACUUM, the counters took 68.7 s
  and the page 86.7 s. The counters test stopped before its ANALYZE, so the zero-row statistics survived its rollback,
  and Home then took 371 s in its first state. That is the "leftovers from earlier rolled-back tests" effect.
- Each guarded block costs two extra round trips (≈ 1 ms). Home is 13 statements instead of 9, a page 4 instead of
  2, the counters 3 instead of 1. The statement-count tests assert where the settings sit.
- Selective filters (one company, one import batch) now hash-join the tracking and e-mail tables instead of looking
  up a few rows: a few milliseconds at V1 scale.
- A future statement that reads the whole prospect base (a new Home figure, an agent's report) should run inside
  `whole_base_plan`. Other multi-table reads (export, explorer) still rely on statistics. The zero-row state
  only lasts until the next ANALYZE.

## Alternatives considered

- **`ANALYZE` (or locking the tables against autovacuum) in the test only**: makes the test pass without making
  Home robust. It measures only the good state and hides a state production can reach.
- **`LEFT JOIN LATERAL (… LIMIT 1)` sources**: the only query shape that forces index lookups whatever the
  estimates. It costs two index probes per prospect on every read, even with good statistics. Every predicate of
  `segments.py` and every Home/Prospection column would have to move to subquery aliases, and the `LIMIT 1` is
  meaningless on unique keys.
- **`ANALYZE` at the end of an import commit**: repairs statistics after the main bulk load, but not after other
  bulk writes (restore, SQL console, CLI). A VACUUM between the ANALYZE and the commit still zeroes them. It would
  also run maintenance inside a request. Not needed for the guarded statements. It remains a possible hardening
  for the unguarded ones.
- **Database-level `enable_nestloop = off` / `jit = off`** (`ALTER DATABASE`): would affect every statement,
  including lookups where a nested loop is right. It is a deployment setting outside the migrations' reach.
- **An index on the audit feed's filters**: measured, not needed. Home's recent edits read 150 000 import events
  newer than every human save in 28 ms (bitmap scan of `ix_audit_log_subject_type_subject_id_occurred_at`).
- **Raising the budget**: would hide a quadratic plan.
