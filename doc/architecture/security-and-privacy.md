# Security, Privacy and Provenance — V1

## Public repository constraint
`circoe-labs/VIPER` was public at review time. The real Excel workbook contains contact information. It is a private local reference only.

Implementation rules:
- do not commit the real workbook;
- add appropriate ignore rules before local fixture use;
- never print raw rows/emails/phones into CI logs or docs;
- commit only synthetic fixtures;
- avoid storing raw uploaded workbook bytes unless explicitly required; store import batch metadata/fingerprint instead.

## Authentication
The functional source requires a single securely authenticated commercial user for the pilot. Implement one-user authentication/session without building a permissions matrix. Internal referents are domain records, not login accounts.

Implemented in Task 04 — design and rationale in [ADR-0004](../adr/0004-authentication-sessions.md):

- **Accounts**: table `users` (email, display name, argon2id hash). No roles; not linked to `internal_referents`.
  Actor identity for mutations = `ActorContext(HUMAN, users.id, display_name)`, built server-side from the session
  (`CurrentActor`), never from a request payload.
- **Sessions**: server-side rows in `user_sessions`, looked up by the SHA-256 of the cookie token; idle timeout
  120 min, absolute 12 h (settings); revoked on logout; token rotated at every sign-in; password reset revokes all.
- **Cookie** `viper_session`: HttpOnly, Secure (default), SameSite=Strict, Path=/api.
- **CSRF**: `X-CSRF-Token` (HMAC of the session token) required on POST/PUT/PATCH/DELETE; sign-in accepts JSON only.
- **Sign-in**: one generic error for unknown email and wrong password (same argon2 cost); 5 failures per email / 20 per
  client address in 15 min → 429 (in-process, single instance).
- **Protected by default**: every `/api/*` route requires a session except `GET /api/health` and
  `POST /api/auth/login` (plus the OpenAPI schema/docs, which expose no data). New routers go into `api_router` and
  inherit the guard; a test walks all routes. The SPA redirects anonymous visitors to `/login` (the API is the real
  boundary).

### Secret handling
- Nothing secret is committed: no default account, no default password, no signing key (none is needed — CSRF tokens
  derive from the session token). `backend/.env.example` holds only non-secret settings; `.env` is git-ignored.
- Passwords exist only as argon2id hashes; the hash is never returned by the API nor logged (tested). Session tokens
  exist only in the browser cookie; the database holds their SHA-256.
- The CLI reads the password from an interactive prompt or stdin, never from arguments.
- Test and E2E accounts are synthetic (`@example.com`); the E2E password is random per run and lives only in the
  Playwright process environment.

### Local/admin setup
- Create or reset the login account (from `backend/`, venv active; targets `VIPER_DATABASE_URL`):
  `python -m app.cli create-user --email <email> --display-name "<Prénom Nom>"` — prompts twice for the password
  (12–1024 characters). Re-running it for an existing email resets the password and signs out every session;
  `--password-stdin` reads one line from stdin for automation.
- Production requirements (HTTPS, proxy headers, single process, timeouts): ADR-0004, *What production must configure*.

## Provenance
Every contact/prospect should be able to retain source, date added and legal-basis/collection-context metadata even when initially unknown. Import origin should include workbook/sheet/row references without exposing them publicly.

Implemented in Task 05 (`ProvenanceService`, [audit-and-provenance.md](audit-and-provenance.md#provenance)):
`prospect_sources` rows with source type, reference, `collected_at`, legal basis / collection context and the actor
snapshot; import sources point to their batch and to a `file / sheet / ligne n` reference. Raw legacy values stay
in `import_row_metadata` (deleted with the prospect), never in the audit log.

## Audit
Meaningful mutations from human/import/Database Explorer must be auditable. Actor model must support future agent/system actors.

Implemented in Task 05 — [audit-and-provenance.md](audit-and-provenance.md), [ADR-0006](../adr/0006-audit-integration.md):

- **Attribution from the server only**: `require_session` binds the signed-in user to the request's database session;
  every audited row change of a signed-in request is recorded with that actor, whatever the payload says (tested
  with a forged actor). Imports record `import` actors on behalf of the confirming user; CLI commands a `system`
  actor. It fails closed: a write to an audited table without an actor raises and rolls back (I-31).
- **Append-only and atomic**: events are written in the same transaction as the change (a rolled-back change
  leaves no event); database triggers reject `UPDATE`/`DELETE`/`TRUNCATE` on `audit_log`.
- **Security trail**: `auth.login`, `auth.logout`, `auth.user_created`, `auth.password_reset` — who and when only.
  No token, token hash, CSRF token, session id, IP address or user agent is stored: the pilot has one account and
  throttling already works from in-memory counters; an IP is personal data with no use for the operator yet.
  Failed sign-ins are not audited (no authenticated actor, and the typed identifier could be a mistyped password).
- **Payload policy** (`app/core/audit_policy.py`, one place): login accounts and sessions never contribute field
  values; secret-looking fields are dropped at any depth; `legacy_metadata` is masked; audit payloads are never
  written to application logs.
- **Contact personal data in audit (decision I-27)**: V1 stores prospect names, email addresses, phone numbers and
  source references **in full** in `changes`, so the history can say "email changed from X to Y" and old values are
  preserved as the company-change rule requires (overview, rule 5). The audit log is read by the same single operator
  who already sees the current values, through the same authenticated API; it is not exported or logged. Because the
  log is append-only and retention is undecided (open question #2), this is **one switch**
  (`POLICY.personal_values`: `full` → `masked` → `omitted`) to tighten before production if the retention policy
  requires it; events already written would then need a subject-scoped redaction migration. Free-text reasons
  (`context.reason`, e.g. why an opposition was lifted) are kept as written: the UI should ask for reasons without
  unnecessary personal detail.

## Do-not-contact
Opposition is durable and distinct from non-interest. Import/merge/new contact tracking must not silently reactivate blocked prospects.

Implemented in the schema (Task 03, [ADR-0002](../adr/0002-data-schema-conventions.md)): `do_not_contact` is a prospect
contactability status, never a contact-tracking stage; a database trigger rejects any write that resets it except the
dedicated `clear_do_not_contact` operation (mandatory reason) and rejects deleting a blocked prospect.

## Database Explorer exposure
The explorer shows only allowlisted domain tables (`app/services/explorer/policy.py`); every other table must be
explicitly withheld — `users` (password hashes) and `user_sessions` (token hashes) are — and objects outside the ORM
are unreachable. Its routes require a session like every non-public route. Columns can be hidden or masked centrally. Queries are validated against metadata
and bound as parameters; the read API has no write method; CSV exports neutralize spreadsheet formulas. Staged writes
(Task 12) go through one separate CSRF-protected endpoint, a default-deny editability policy (opposition columns,
provenance traces, import traces and the audit log are read-only) and the ORM, so every change is audited with the
server-side actor. Details: [database-explorer.md](../features/database-explorer.md),
[ADR-0008](../adr/0008-explorer-staged-writes.md).

### SQL console (Task 13)
Read-only by construction, enforced by PostgreSQL ([ADR-0011](../adr/0011-read-only-sql-console.md)): queries run as
the dedicated login role `viper_sql_reader` — no attribute beyond LOGIN, no role membership, `SELECT` granted only on
the visible, unmasked columns of the exposed tables (test-compared with the exposure policy), read-only default
transaction and timeouts — each on its own connection, in a `READ ONLY` transaction, as a prepared statement through a
server-side cursor (bounded rows). `users`, `user_sessions`, `alembic_version` and administrative functions are
refused by the database. The password comes from `VIPER_SQL_READER_PASSWORD` (the default is a local-development
value, like `viper`/`viper`; set a real secret anywhere else, never commit it). Every query is audited by hash and
length, never by text (it may carry personal literals). Catalog object names remain readable, as for any role.

## Retention/backup/deletion
Exact retention, anonymization, hosting and backup requirements remain product/ops/legal decisions. The implementation should centralize configuration and avoid destructive cascade defaults that make later compliance impossible.

Current deletion rules (Task 03): taxonomy/referent/company references are RESTRICT (deactivate instead of delete);
deleting a prospect cascades to its own personal data (emails, phones, tracking, sources, import row metadata);
`audit_log` has no FKs and is append-only (UPDATE/DELETE/TRUNCATE rejected by triggers), so purging or redacting it
under a future retention policy requires an explicit, reviewed migration. Erasing a prospect keeps its audit events
(with full contact values under decision I-27); they are all findable by `subject_type = 'prospect'` and
`subject_id`, which is what such a redaction would target. Import batches store metadata and an optional SHA-256
fingerprint, never workbook bytes.

## Excel export (Task 10)
`GET /api/exports/workbook` returns the whole normalized database — personal data — as one XLSX
([ADR-0013](../adr/0013-normalized-excel-export.md)): session required (like every route), built in memory and never
stored server-side, `Cache-Control: no-store`, and each download audited as `export.generated` with the signed-in user
and counts only. Cells are formula-free: every text is a string cell and a formula-like text also carries Excel's
`quotePrefix` (the explorer CSV's detection rule, shared in `app/core/spreadsheet.py`). openpyxl's write-only mode
streams the sheets through temporary files, deleted when the workbook is saved. The private compatibility check never
writes the exported real workbook to disk.

## Excel import uploads (Task 09)
The review is stateless (ADR-0012): the workbook stays in the browser and is re-sent for each analysis and for the
commit; nothing is stored server-side. Upload bodies are parsed only after the session and CSRF checks and a
`Content-Length` bound (file limit + 2 MiB); the engine enforces the exact limits (ADR-0007). Refusals never echo
submitted values, and a failed commit logs only the exception class and the row number.
