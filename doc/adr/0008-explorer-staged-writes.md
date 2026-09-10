# ADR-0008 — Database Explorer writes: staged change sets, optimistic row versions, ORM application

- Status: accepted
- Date: 2026-09-10
- Deciders: Task 12 (Database Explorer staged editing), for orchestrator review
- Related: [ADR-0005](0005-database-explorer-grid.md) (read path), [ADR-0006](0006-audit-integration.md) (audit),
  [ADR-0002](0002-data-schema-conventions.md) (constraints, do-not-contact trigger, deletion rules),
  `doc/features/database-explorer.md` (*Staged editing*), decision log I-60 … I-66
- Number: 0007 is left to a parallel branch.

## Context

The user wants DBeaver-like direct editing (edit cells, add and delete rows) with pending changes, Save/Cancel,
validation and audit. The explorer is generic (sixteen tables), but its writes must not bypass the integrity rules
that business services enforce: durable do-not-contact, the company-change rule (I-13), the contact-tracking status
history, provenance, and the audit (every write attributed server-side, fail closed). Tables outside the audit
registry must stay read-only unless their writes are audited another way. Several questions need one answer: what the
client sends, how the server applies it atomically, how concurrent edits are detected, and how refusals come back.

## Decision

1. **Staging happens in the browser, per table.** The grid keeps cell edits, new rows and deletions in a pure reducer
   (`frontend/src/database/staging.ts`) until `Enregistrer`; `Annuler` drops them. Nothing is written before Save.
   Leaving the table with staged changes asks for confirmation (router blocker + `beforeunload`).
2. **One change set per request and per table**: `POST /api/explorer/tables/{table}/changes` with
   `{updates: [{key, version, values}], inserts: [{values}], deletes: [{key, version}]}`, on a router separate from
   the GET-only read router (`explorer_writes.py`) whose dependency records `source = database_explorer`.
3. **Validation against the same metadata as reads**, extended with editability (`policy.py`: default-deny
   `TableWrites` per table, `ColumnPolicy.edit` = editable / set at creation / read-only with a French reason;
   structural rules in `metadata.py`). Every error is collected per change and per column; any error → nothing
   applied.
4. **Application through the ORM in the request's transaction**, so the audit flush hook records each row with the
   signed-in actor. Rows are locked (`SELECT … FOR UPDATE`) and checked (existence, version, foreign-key targets,
   domain blockers) before anything is written; then deletes, updates and inserts run **each in a savepoint**, and a
   change refused by the database is retried after the others (unique/partial-unique indexes such as "one primary
   e-mail" cannot be deferred in PostgreSQL, so a swap would otherwise depend on edit order), until a pass makes no
   progress. Remaining errors raise; the request's unit of work rolls everything back.
5. **Domain rules are delegated, not duplicated**: a prospect's `company_id` goes through
   `prospects.change_company`, contact tracking through `save_contact_tracking`; opposition columns and provenance
   traces are read-only; prospects are not created here (provenance). Link tables not audited as rows
   (`company_activity_categories`) are written through their audited owner's collection (`writes.LINK_TABLES`); a test
   forbids explorer writes to any other unaudited table.
6. **Optimistic concurrency with the row's `updated_at`**: the client sends back the version it read; a different
   current value (the `set_updated_at` trigger bumps it on every UPDATE, whatever the write path) → `409` conflict,
   nothing applied. Deletes carry it too.
7. **Refusals in French, per change**: database errors are mapped by constraint name (`CONSTRAINT_MESSAGES`, with the
   column to highlight; a test requires every UNIQUE/CHECK of a writable table to be listed), plus generic mappings
   for enum CHECKs, foreign keys, NOT NULL and the do-not-contact trigger (SQLSTATE `23001`).
8. **Delete diagnostics before confirmation**: `GET …/delete-check` walks the ORM metadata's incoming foreign keys
   (RESTRICT → blocker, CASCADE → counted and walked further, SET NULL → counted) plus domain blockers; several rows
   at once only on tables from which no deletion cascades.

## Consequences

- The explorer can edit most domain data while the service-owned rules, the audit and the durable opposition hold;
  the policy is one reviewed file, and new tables are read-only until classified.
- A save is atomic and reports every problem at once; the grid puts errors back on cells.
- Row-level versions reject a save when *any* column of the row changed meanwhile (even one the user did not edit):
  safe, occasionally conservative; the user refreshes and redoes the edit.
- Retrying failed changes costs extra savepoints only when something fails; a genuine cycle (swapping two unique
  values between rows) still needs two saves.
- Rows removed by `ON DELETE CASCADE` are not audited individually (ADR-0006 limit); the dialog says so.
- Staged changes are per browser tab and per table; they are lost after a confirmed exit.

## Alternatives considered

- **Immediate per-cell PATCH** — simplest, but no reviewable pending state, no Cancel, no atomic multi-row change and
  one audit request per keystroke-level change; the user asked for staged Save/Cancel.
- **Original values of the edited fields as the concurrency token** (DBeaver style) — tolerates unrelated concurrent
  edits, but needs every edited value to round-trip exactly (timestamps, text normalization) and still misses
  semantic conflicts; `updated_at` already exists on every writable row and is trigger-maintained.
- **Pessimistic locks while editing** — impossible to hold across HTTP requests without a lock table and timeouts.
- **Core/SQL statements instead of the ORM** — invisible to the audit hook (each write would need `record_event`) and
  would bypass the service rules; rejected.
- **Deferrable constraints** — PostgreSQL cannot defer unique *indexes* (partial ones included), which carry the
  "one primary" rules; the retry pass handles ordering without changing the schema.
- **Cross-table change sets** — more general, but staged state per table keeps the UI and the error mapping simple;
  the dirty-navigation guard makes the boundary explicit.
- **Deleting cascaded children through the ORM to audit each one** — would copy every child's personal values into
  the append-only log on each deletion; the parent's event and the diagnostics dialog are enough for V1.
