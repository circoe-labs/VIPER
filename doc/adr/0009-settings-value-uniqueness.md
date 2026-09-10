# ADR-0009 — Settings values: accent-insensitive uniqueness in the database (`unaccent` + `label_key`)

- Status: accepted
- Date: 2026-09-10
- Deciders: Task 06 (Settings taxonomies and internal referents), for orchestrator review
- Related: `doc/features/settings-taxonomies.md`, `doc/product/decision-log.md` (I-32 … I-36), ADR-0002
  (constraint naming, "label unique case-insensitively"), migration `backend/migrations/versions/0005_settings_uniqueness.py`
- Number: 0007 and 0008 are reserved by the parallel Task 08 and Task 12 branches.

## Context

Task 06 requires duplicate prevention for taxonomy labels that is **case- and accent-insensitive** with an
understandable error. Task 03 made labels unique on `lower(label)` only, so `Entrepôt` and `Entrepot` could coexist.
The operator types French labels with and without accents, and duplicates split references (prospects on two
"identical" roles) — exactly what administrable taxonomies must avoid. Several write paths exist or are coming: the
Settings page, inline creation from record pickers (Tasks 07/15), the seed, and generic Database Explorer edits
(Task 12) that do not go through `TaxonomyService`. Internal referents had no uniqueness at all.

## Decision

1. Migration `0005` creates the `unaccent` extension (contrib, *trusted* since PostgreSQL 13, so a database owner can
   create it) and an immutable SQL function

   ```sql
   label_key(text) = lower(unaccent('public.unaccent', regexp_replace(btrim(value), '\s+', ' ', 'g')))
   ```

   written with an SQL-standard body (dependencies tracked, independent of `search_path`). The two-argument
   `unaccent` with an explicit dictionary is what makes marking it `IMMUTABLE` acceptable.
2. Taxonomy labels are unique on `label_key(label)` (`uq_<table>_label_key`, replacing `uq_<table>_lower_label`),
   inactive rows included. Internal referents are unique on `(label_key(first_name), label_key(last_name))`
   (`uq_internal_referents_name_key`) and on `email` (`uq_internal_referents_email`, NULLs allowed).
3. Services never re-implement the folding: repositories compare and search through the same `label_key` function
   (`app/repositories/taxonomies.py`), so a pre-check and the index agree. The pre-check gives the friendly 409 with
   the existing value; a violation that races past it is translated to the same error inside a savepoint
   (`app.services.errors.translated_violations`). The frontend's `foldText` mirrors the rule only to filter pickers
   and to decide whether to offer « Créer « … » »; the server remains the judge.

## Consequences

- Every write path — Settings, pickers, seed (`ON CONFLICT DO NOTHING` also skips label-key clashes), Explorer edits,
  raw SQL — is protected by the database.
- The migration fails on a database that already holds colliding labels or referents; they must be merged/renamed
  first (none exist yet in V1).
- The hosting database must allow the `unaccent` extension (all mainstream PostgreSQL offerings do). Downgrading
  `0005` drops the function and the extension.
- `label_key` is also the matching key available to the Excel import (Task 08/09) for mapping legacy roles/categories
  to existing values.
- Folding is broader than French accents (`unaccent`'s rules: ligatures `œ → oe`, `ß → ss`…), which is the desired
  behaviour for labels.

## Alternatives considered

- **Service-only check in Python** — simplest, but generic Explorer writes and future agents would bypass it, and it
  duplicates the folding rule in two languages.
- **`citext` / nondeterministic ICU collation** (`CREATE COLLATION … deterministic = false`) — ICU collations give
  accent-insensitive equality, but PostgreSQL 16 does not support `LIKE`/pattern operations on nondeterministic
  collations and they complicate ordering and the explorer's filters; `citext` is only case-insensitive.
- **A stored `label_key` column filled by the application** — needs every writer to maintain it (or a trigger);
  an expression index gives the same guarantee with no extra column.
- **`translate()` with a hand-written accent table** — no extension needed, but incomplete (ligatures) and a second
  folding table to maintain.
