# ADR-0012 — Import review: stateless re-analysis, digest-bound commit, one savepoint

- Status: accepted
- Date: 2026-09-10
- Deciders: Task 09 (import review and commit), for orchestrator review
- Related: ADR-0007 (pure import engine), ADR-0006 (audit, import actor), `doc/features/excel-import-export.md`
  (*Import review and commit — as implemented*), decision log I-72 … I-79

## Context

Task 08's engine turns an uploaded file into a deterministic `ImportPreview`. Task 09 must let the user review it
(sheet, values to resolve, duplicates, corrections, exclusions) and then write everything in one audited transaction.
Between the upload and the commit, something must hold the preview. Constraints: the workbook is personal data and
must not be stored by default; the database may change between review and commit (a prospect marked
« Ne pas contacter », a new company or role); a commit must apply exactly what the user saw; a failure must leave no
partial data; the history must show every attempt.

## Decision

1. **Stateless review: the browser keeps the file.** `POST /api/imports/preview` receives the file (multipart) and
   optional `options` (sheet/column mapping, per-cell corrections) and returns the review — the preview, values
   grouped by raw value with conservative defaults, per-row default resolutions, the named duplicate candidates —
   plus a **digest**: SHA-256 of the canonical JSON of the preview. Nothing is written and nothing is kept on the
   server. Every new analysis (a correction, another sheet, a Settings change followed by « Relancer l'analyse ») sends
   the file again; the engine is cheap (≈ 0.35 s for the 339-row workbook).
2. **Corrections go through the engine.** A corrected cell (`corrections: {row: {field: text}}`) replaces the cell
   *before* the engine runs, so normalization, matching, duplicate detection and do-not-contact blocking always apply
   to what will be written; the original value stays in legacy metadata (`<field>_original`, reason `corrected`).
   Grouped decisions (role, category, referent, civility, week year, company) and row resolutions (create, attach to
   an existing prospect, merge into another row, exclude) are *decisions*, applied at commit time over the preview.
3. **Digest-bound commit.** `POST /api/imports/commit` receives the file again with the decisions, which carry the
   file fingerprint and the preview digest. The server loads a fresh reference snapshot, re-runs the engine with the
   same mapping and corrections and refuses with 409 when the file differs (`file_changed`) or the preview differs
   (`preview_outdated`: the database changed in a way the user has not seen — a new duplicate, a new opposition, a
   removed value). The user re-analyses; decisions keyed by raw value and row number survive (the client prunes the
   ones that no longer apply). A committed batch with the same fingerprint requires `acknowledge_reimport`
   (409 `reimport_not_acknowledged`): a prominent warning, not a block.
4. **Validated plan, then one savepoint.** `review.plan_import` (pure) applies the overrides to the defaults and
   validates them against the preview and the snapshot (unknown keys or ids, a year without that ISO week, a
   do-not-contact row created, a prospect without name created, a merge into an excluded row or a non-candidate…);
   any error → 422 `invalid_decisions`, nothing written. The writes then run in **one savepoint** of the request's
   transaction: values the user chose to create (Settings service, by the user), batch `pending` (by the user), then —
   inside `import_batches.importing` (import actor on behalf of the user) — companies, prospects or merges, contact
   tracking, one provenance source and one `import_row_metadata` per imported row, batch `committed`.
5. **Failure = rollback + a failed batch record.** Any exception while writing rolls the savepoint back (no partial
   data, no audit event of the attempt) and records a `failed` batch (started/failed events by the user, counts 0) in
   the *same* request transaction, which the route commits by returning the error response instead of raising
   (500 `commit_failed`, 422 when a value was refused). Only the exception class and the row number are logged:
   database messages can quote imported values.
6. **Multipart parsed after the guard.** FastAPI parses declared form parameters before any dependency; the upload
   routes read the body themselves after `require_session` (session + CSRF) and a `Content-Length` bound (file limit
   + 2 MiB for the JSON part, 411 without length), using `python-multipart` (new dependency, the standard FastAPI
   multipart parser). The engine keeps the exact file limit.

## Consequences

- No workbook bytes are stored, in a temporary table or on disk; a server restart loses nothing but the page state.
- The file travels at most twice per analysis/commit cycle (10 MiB limit); acceptable for a single pilot user.
- A commit is exactly the reviewed preview: concurrent changes cannot slip in silently, at the cost of a re-analysis
  when anything changed (even an unrelated new company that becomes a candidate).
- Values to create are created only at commit time and inside the same savepoint: a failed import leaves no orphan
  role/category. Their audit events are by the user (`source=ui`); import rows by the import actor (I-29).
- The client mirrors the plan rules to show blocking rows and the commit summary before sending; the server remains
  the authority and validates again.
- Commit cost is linear (≈ 7.7 s for the 339-row workbook on the local Docker database, one flush per step with the
  audit hook); good enough for occasional imports, to batch if files grow by an order of magnitude.

## Alternatives considered

- **Server-side preview session with expiry** (temporary table or files keyed by a token): avoids re-sending the file,
  but stores personal data outside the domain tables (retention, cleanup job, privacy review) and still needs a
  staleness check against the live database.
- **Commit from the client's copy of the preview** (no re-analysis): trusts a client-supplied JSON of proposals —
  a modified or stale payload could recreate a do-not-contact person or skip a duplicate check.
- **Corrections applied after the engine** (typed values patched into proposals): cheaper, but a corrected e-mail or
  name would escape duplicate and do-not-contact detection.
- **Separate unit of work for the failed batch**: equivalent result; the savepoint keeps the service testable within
  one session and the route free of a second transaction.
