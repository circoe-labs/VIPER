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

## Audit
Meaningful mutations from human/import/Database Explorer must be auditable. Actor model must support future agent/system actors.

## Do-not-contact
Opposition is durable and distinct from non-interest. Import/merge/new contact tracking must not silently reactivate blocked prospects.

Implemented in the schema (Task 03, [ADR-0002](../adr/0002-data-schema-conventions.md)): `do_not_contact` is a prospect
contactability status, never a contact-tracking stage; a database trigger rejects any write that resets it except the
dedicated `clear_do_not_contact` operation (mandatory reason) and rejects deleting a blocked prospect.

## Retention/backup/deletion
Exact retention, anonymization, hosting and backup requirements remain product/ops/legal decisions. The implementation should centralize configuration and avoid destructive cascade defaults that make later compliance impossible.

Current deletion rules (Task 03): taxonomy/referent/company references are RESTRICT (deactivate instead of delete);
deleting a prospect cascades to its own personal data (emails, phones, tracking, sources, import row metadata);
`audit_log` has no FKs and is append-only (UPDATE/DELETE/TRUNCATE rejected by triggers), so purging or redacting it
under a future retention policy requires an explicit, reviewed migration. Import batches store metadata and an
optional SHA-256 fingerprint, never workbook bytes.
