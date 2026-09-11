# ADR-0017 — Global search: folded search keys, a word-start rule for short words, `pg_trgm` GIN indexes

- Status: accepted
- Date: 2026-09-11
- Deciders: Task 17 (global search), for orchestrator review
- Related: `doc/features/global-search.md`, decision log I-120 … I-129, ADR-0002 (normalized storage; "Task 17
  decides on `pg_trgm`"), ADR-0009 (`unaccent`, `label_key`), ADR-0014 (read-only query services build their
  statements), migration `backend/migrations/versions/0007_search_indexes.py`
- Number: 0015 and 0016 are left to the parallel Task 15 branch.

## Context

The shell gets one search field that must find prospects (name, e-mail, phone), companies (display/legal name,
SIREN, website/domain) and establishments (SIRET, name, city) while the user types — the handoff target is p95
< 150 ms locally on a 20 000-prospect base. Names must match regardless of case and accents (`elodie` finds
Élodie), inside hyphenated names and in any word order. ADR-0002 and ADR-0005 left substring indexing open for this
task. Two index families are possible in PostgreSQL:

- **expression B-tree indexes with `text_pattern_ops`** — serve `LIKE 'abc%'` (the value *starts with*), nothing else;
- **`pg_trgm` GIN indexes** — serve `LIKE`/`ILIKE` with a leading wildcard (`'%abc%'`), and a word start (`'ab%'`,
  `'% ab%'`, the padded trigrams `"  a"`, `" ab"`) even for two characters, at the cost of a contrib extension and
  slower writes.

## Measurements

Development machine (Windows 11, PostgreSQL 16 in Docker Desktop), committed synthetic base after `VACUUM ANALYZE`:
20 000 prospects, 25 000 e-mail addresses, 20 000 phone numbers, 2 000 companies, 2 982 establishments
(`tests/test_search_performance.py::seed_base`). 28 queries (2-letter starts, names, accents, e-mail and phone
fragments, SIREN, SIRET, domains, websites, cities, misses) × 10 runs through the service (3 statements each):

| Variant | p50 | p95 | max | worst query |
|---|---|---|---|---|
| `label_key` folding, trigram GIN on `label_key(...)`, every word matched anywhere | 34.9 ms | 231.9 ms | 828.6 ms | `ma`: 290 ms median — a 2-character substring has no trigram, so every name of the base is folded (`label_key` ≈ 6.5 µs per value: its whitespace regex dominates) and re-folded for ranking |
| **chosen**: `search_key` folding, words < 3 characters only at a word start, trigram GIN on 7 expressions | **21.3 ms** | **39.8 ms** | **60.0 ms** | `ma` (3 000 candidates) 53 ms |
| chosen queries, no trigram index | 71.7 ms | 208.9 ms | 242.7 ms | `ma`, `du`, `xq`, `06 12`: ≈ 200 ms (sequential scans folding every row) |

One statement, `mar` on the 20 000 names, top 6 by name: B-tree `text_pattern_ops` on `search_key(last_name)` and
`search_key(first_name)` (starts-with only) 12.2 ms; trigram GIN on the folded full name (anywhere) 20.7 ms; no index
43–59 ms. Through HTTP (pytest `TestClient`, authentication included, warm-up, 5 runs × 28 queries): p95 50–57 ms over
three runs. Writes: 5 000 raw prospect inserts take 199 ms with the name trigram index instead of 148 ms (≈ 10 µs per
row). Index sizes on that base: prospects 704 kB, e-mails 1.5 MB, phones 720 kB, companies 200 + 88 kB, establishments
48 + 64 kB.

## Decision

1. **`pg_trgm` GIN indexes** (migration 0007) on the expressions the search compares:
   `person_search_key(first_name, last_name)` (prospects), `emails.address`, `phones.number`,
   `search_key(display_name)` and `search_key(legal_name)` (companies), `search_key(name)` and `search_key(city)`
   (establishments). SIREN, SIRET, e-mail domain and website are read by scans of the small company/establishment
   tables (≈ 1 ms at 2 000 rows).
2. **`search_key(text)`** = `lower(unaccent('public.unaccent', value))` — `label_key` without the whitespace clean-up
   (irrelevant for substring matching, ≈ 4× cheaper per row); **`person_search_key(first, last)`** = `search_key` of
   "first last". Both immutable SQL-standard functions, so the indexes and the queries use one expression.
   `label_key` stays the uniqueness key of Settings values.
3. **Words shorter than 3 characters match only at the start of a word** (value start, or after a space, hyphen or
   apostrophe): `ma` finds *Martin* and *Saint-Mars*, not *Thomas*. Longer words match anywhere. This keeps every
   predicate index-assisted — a 2-character substring has no trigram — and is what a user typing two letters
   expects.
4. **Candidates first, then ranking**: each field is a `LIKE` over its indexed expression; the folded key is computed
   once per candidate (an `OFFSET 0` sub-select keeps PostgreSQL from folding it again for the rank); the rank (exact
   / word start / anywhere) and the order by name are computed on candidates only.
5. `pg_trgm` is created in schema `public` like `unaccent`; it is a *trusted* extension since PostgreSQL 13, so a
   database owner can create it. **Production must allow `pg_trgm`** (all mainstream managed PostgreSQL offerings do).

## Consequences

- p95 ≈ 40 ms (service) / ≈ 55 ms (HTTP) on 20 000 prospects: well inside the 150 ms target, with a margin for a base
  several times larger. `tests/test_search_performance.py` keeps the budget (20 000 prospects locally, 2 000 in CI).
- Every write to a searched column also updates a GIN index (≈ 10 µs per row, fast-update pending list merged by
  autovacuum); negligible next to the audited ORM writes of V1.
- The ORM declares the indexes through `app.models.common.trigram_index` (expression + `postgresql_ops`), so the
  migration/ORM drift test compares them like any other index.
- Downgrading 0007 drops the indexes, the two functions and the extension.
- The Database Explorer's search (`ILIKE`, not accent-insensitive, ADR-0005) and Prospection's `q` (ADR-0014,
  `label_key`/`strpos`) keep their semantics; the trigram indexes on `emails.address` and `phones.number` may serve
  the explorer's `ILIKE` on those tables incidentally, nothing more is promised.

## Alternatives considered

- **B-tree `text_pattern_ops` expression indexes** — fastest for a starts-with (12 ms), but only a starts-with of the
  whole indexed value: no match inside hyphenated or compound names, no e-mail or phone fragment, one index per
  first/last name. Rejected: the search must find substrings.
- **No index** — simplest, p95 209 ms: fails the target, and every keystroke would fold the whole base.
- **Trigrams over `label_key`** — the first implementation: correct results, but 2-character queries scan and fold
  every row with the costlier function (p95 232 ms, max 829 ms).
- **Stored generated key columns** (`GENERATED ALWAYS AS (search_key(...)) STORED`) — would remove folding at read
  time entirely, but adds columns to four domain tables that the explorer, the SQL console grants, the audit payloads
  and the export would all have to classify; the expression indexes reach the target without touching the schema of
  the rows.
- **Full-text search (`tsvector`)** — stemming and dictionaries fit prose, not names, SIREN or phone fragments, and
  prefix search on `tsquery` is word-based only.
