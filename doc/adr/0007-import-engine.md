# ADR-0007 — Excel/CSV import engine: pure preview model, adapter placement, determinism, limits

- Status: accepted
- Date: 2026-09-10
- Deciders: Task 08 (import core), for orchestrator review
- Related: `doc/features/excel-import-export.md` (*Import engine — as implemented*), `doc/legacy/legacy-data-profile.md`,
  `doc/product/decision-log.md` (I-50 … I-59), ADR-0001 (stack), ADR-0002 (normalized storage, do-not-contact
  trigger), ADR-0006 (import actor), Tasks 09 (review/commit) and 10 (export)

## Context

The historical workbook is semantically messy (markers in `Référent`, week codes without year, a repeated header,
numbered categories, `0` placeholders, duplicates) and personal. Task 08 must turn an uploaded XLSX/CSV into a typed
preview with diagnostics, suggestions and duplicate candidates, which Task 09 then shows, lets the user correct and
commits in one audited transaction. Constraints: no database writes, no silent loss, never invent a year or a
referent, never create a taxonomy value, never reactivate a do-not-contact prospect, safe on untrusted files, and
testable without the private workbook (which never enters the repository).

## Decision

1. **A pure function.** `build_preview(ImportFile, ImportReferenceData, ImportMapping | None, *, limits)` returns an
   `ImportPreview`. It reads nothing but its arguments — no database, clock, randomness or network — so it runs
   without a database (tested with sockets disabled) and is deterministic (same input → identical JSON; inputs are
   processed in source order, every set/dict that reaches the output is sorted with explicit tie-breakers; tested
   with a reordered reference snapshot). Files that cannot be read at all raise `ImportRejectedError` (a
   `InvalidInputError` carrying a catalogue diagnostic); everything else is a diagnostic.
2. **Reference data as a snapshot.** Roles, activity categories, commercial segments, referents (active and
   inactive), companies and prospects (+ emails, contactability) arrive as frozen dataclasses. A separate
   `reference_loader.load_reference_data(session)` builds them with SELECTs through
   `app/repositories/import_reference.py`; it is the only module of the package that touches the database, and a
   test forbids database imports in every other engine module.
3. **Placement: `app/services/imports/`**, beside the explorer adapter (I-41), because the overview lists
   `ImportPreviewService` among application services and Task 09's commit service will live next to it. Legacy
   column names are an adapter concern and live in **one module, `fields.py`** (`LEGACY_LAYOUT`, reusable by Task
   10's compatibility export); domain services never see them. Inside the package: `workbook.py` (file adapters,
   no legacy knowledge), `layout.py` (sheet recognition, column mapping, user overrides), `normalize.py` and
   `matching.py` (pure value rules), `rows.py` (row assembly, lossless legacy metadata), `dedup.py`,
   `diagnostics.py` (the catalogue: code, fixed severity, French message), `models.py` (pydantic output), `preview.py`.
4. **Output = proposals.** Pydantic models (JSON-ready for the Task 09 API). Taxonomy/referent matches carry
   `match` and `requires_confirmation`; duplicates are candidates with reasons and confidence; a do-not-contact
   match blocks the row (error) and proposals never carry contactability, so no merge can reactivate anybody.
5. **Lossless by construction.** Each non-empty cell is reported with `mapped` / `preserved`; raw values go to
   `legacy_metadata` (`{column, header, value, reason}`) whenever the conversion is partial, impossible, a guess or
   not storable; a final pass preserves any cell no rule consumed. A property test checks it on generated rows.
6. **Untrusted input, bounded.** openpyxl 3.1.5 in read-only, `data_only` mode (values, never formulas); merge
   ranges read with the standard library (read-only mode hides them). Limits are settings: file size (10 MiB),
   non-empty rows per sheet (5000), columns (100), plus an unzipped-size cap of 10 × the file limit against zip
   bombs (openpyxl keeps shared strings in memory). Encrypted and legacy `.xls` files are recognised by their OLE
   signature. Library exceptions are not chained (their text may contain cell values); messages never embed cell
   values — the raw value travels separately in `Diagnostic.value`, so counts can be logged safely.
7. **Private compatibility smoke** marked `private`, skipped unless `VIPER_PRIVATE_WORKBOOK` is set, asserting
   structure and printing counts per code only. Synthetic workbooks are generated in memory by
   `tests/fixtures/synthetic/legacy_workbook.py`; no spreadsheet file is committed.

## Consequences

- Task 09 calls `load_reference_data` then `build_preview`, keeps the preview (or re-runs it: it is cheap and
  deterministic — ~1 s for the 339-row workbook), applies user decisions and commits through services inside
  `import_batches.importing(...)`. User remapping is a new preview with an `ImportMapping`; value-level decisions
  (which role/category/referent/year, which duplicate) are Task 09's.
- The whole prospect set is loaded for dedup; fine at V1 scale (thousands), to revisit with indexed lookups if the
  base grows by orders of magnitude.
- New legacy variants mean editing `fields.py`, `normalize.py` or `matching.py` and adding a synthetic case; new
  diagnostics need a catalogue entry and a line in the feature doc (a test enforces both).
- openpyxl adds a runtime dependency (+ `types-openpyxl` for mypy); it is also what Task 10 will use to write.

## Alternatives considered

- **pandas** — convenient, but a heavy dependency that coerces types (phone numbers, `0`, dates) before we can see
  the raw cell, which is exactly what the diagnostics need.
- **openpyxl normal mode** (exposes merged cells) — loads the whole workbook object graph; read-only streaming plus a
  small XML scan keeps memory bounded by the limits.
- **Engine reading the database directly** — simpler call site, but untestable without a database, non-deterministic
  under concurrent edits and harder to reason about; the snapshot makes the dependency explicit.
- **A top-level `app/adapters/` package** — would introduce a new layer for one feature; the legacy knowledge is
  already confined to one module.
- **Raising on bad rows** — a single bad cell would hide all other findings; the user needs the full picture before
  deciding.
