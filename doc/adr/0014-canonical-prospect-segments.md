# ADR-0014 — Canonical prospect segments as SQL predicates

- Status: accepted
- Date: 2026-09-11
- Deciders: Task 14 (Prospection workspace), for orchestrator review
- Related: `doc/features/prospection-kpis.md`, decision log I-90 … I-94, ADR-0005 (explorer statements precedent)

## Context

Prospection shows counters (never verified, due, no response…) that must filter the people list to exactly the same
people, and Home (Task 16) must show the same KPIs. The definitions combine several tables (prospect, contact
tracking, primary e-mail, e-mail/phone history of a company change) and a clock (business day, optional stale
threshold). If each screen re-derived them — a Python loop here, a different SQL query there — counts and lists would
drift, and N+1 queries would creep in.

## Decision

1. **One module owns the semantics**: `app/services/prospection/segments.py` defines `Segment` (the URL/API keys), a
   `SegmentContext` (business day, optional `stale_days`), the FROM every definition reads (`join_segment_sources`:
   prospect + company + single tracking + primary e-mail, each at most one row, so prospects are never multiplied)
   and `predicate(segment, context)` returning a SQLAlchemy boolean expression. Row states shown in the list
   (`verification_state`, `email_state`, `due`) are built from the same expressions.
2. **Counters are one aggregate statement** — `count(*) FILTER (WHERE predicate)` for every segment over the same FROM
   and the same criteria as the list; the list adds `WHERE predicate(segment)`. A counter therefore equals the list
   total by construction (and a test checks it on random bases).
3. The query service (`app/services/prospection/query.py`) is self-contained and read-only, building its statements
   itself like the Database Explorer's adapter (I-41): its joins exist only to serve these views, and the predicates
   are SQL by nature. Home imports `segments` / `query` rather than repositories.

## Consequences

- Home, exports or future agents get the same numbers by calling `count_segments` / `predicate`; a definition change
  is one edit plus the expected-members table in `tests/test_prospection.py`.
- Time-dependent segments take their clock from the caller (`SegmentContext.at(now, stale_days)`), so tests fix the
  day and the stale threshold stays a setting until product chooses it (open question #9).
- The page costs 3 statements (counters, rows, total); fine at V1 scale (20 000 prospects: ≈ 0.25 s / 0.15 s).

## Alternatives considered

- **Materialized status columns or a view** (e.g. `is_due`): would need triggers or refreshes on every tracking,
  channel and clock change, and "today" cannot be materialized.
- **Computing states in Python over loaded rows**: loads the whole base for counters, and duplicates logic between
  counting and filtering.
- **Front-end derivation**: the browser would re-implement business rules and could not count what it does not load.
