# ADR-0004 — Authentication: server-side sessions, argon2id, cookie + CSRF, router-level protection

- Status: accepted
- Date: 2026-09-10
- Deciders: Task 04 (authentication and actor context), for orchestrator review
- Related: `doc/architecture/security-and-privacy.md` (*Authentication*), `doc/product/decision-log.md` (I-23…I-25),
  ADR-0001 (stack), ADR-0002 (actor snapshot), migration `backend/migrations/versions/0003_authentication.py`

## Context

The source of truth asks for **one securely authenticated commercial user** for the pilot, without an RBAC matrix,
and for a server-side actor identity that every mutation (and later the audit log, Task 05) can record. Internal
referents are domain records, not accounts. The repository is public: no secret, default password or real account
may be committed. The SPA and the API share one origin (Vite proxies `/api` in development; a reverse proxy will do
the same in production). The production identity provider is not decided and must be replaceable without touching
domain records.

## Decision

### Accounts and sessions — server-side, in PostgreSQL

- `users` (`email` unique lowercase, `display_name`, `password_hash`, timestamps). Nothing limits it to one row: the
  pilot has one account, a second one is an `INSERT` away. No roles. Not linked to `internal_referents`.
- `user_sessions` (`user_id` → `users` ON DELETE CASCADE, `token_hash` unique, `created_at`, `last_seen_at`,
  `expires_at`, `revoked_at`). The browser holds a 256-bit random token (`secrets.token_urlsafe(32)`); the database
  stores only its **SHA-256** (a fast hash is enough for a random 256-bit value; a database leak yields no usable
  cookie).
- A session is live while not revoked, before `expires_at` (**absolute** limit, default 12 h after sign-in) and less
  than the **idle** timeout (default 120 min) after `last_seen_at`. `last_seen_at` is bumped at most once a minute.
  Both limits are settings (`VIPER_SESSION_IDLE_TIMEOUT_MINUTES`, `VIPER_SESSION_ABSOLUTE_TIMEOUT_HOURS`).
- Sign-in always creates a new session with a fresh token (never a client-chosen one) and revokes the session of any
  cookie the browser still sent — no fixation, token rotated at every login. Logout revokes server-side. The user's
  dead (revoked/expired) sessions are deleted at the next sign-in. Resetting the password (CLI) revokes all sessions.

### Passwords — argon2id

- `argon2-cffi` 25.1.0, profile **RFC 9106 low-memory**: argon2id, t = 3, m = 64 MiB, p = 4, 16-byte salt, 32-byte
  tag (~50 ms per hash on the development machine). The PHC string carries its parameters; a hash made with other
  parameters is transparently re-hashed at the next successful sign-in.
- Constant-effort check: an unknown email is verified against a dummy hash, so it costs one argon2 verification
  like a wrong password, and both get the same `401 {"detail": "Invalid email or password."}` — no enumeration by
  message, status or timing. argon2 compares tags in constant time.
- Passwords are 12–1024 characters when set (CLI); sign-in input is capped at 1024. The hash is never serialized
  (response models expose `id`, `email`, `display_name` only) nor logged; the request model holds the password as a
  `SecretStr`.

### Cookie

`viper_session`, **HttpOnly**, **Secure** (setting `VIPER_SESSION_COOKIE_SECURE`, default `true`),
**SameSite=Strict**, **Path=/api**, `Max-Age` = absolute timeout.

- *Strict rather than Lax*: the cookie is only needed by the SPA's own `fetch` calls to `/api`, which are same-site
  requests. It is never needed on a top-level cross-site navigation (those load the HTML shell, which is public), so
  Strict costs nothing and removes Lax's top-level-GET exposure.
- *Path=/api*: pages and static assets never carry it.
- *Secure by default*: browsers (Chromium, Firefox) accept Secure cookies from `http://localhost`, so local
  development and the E2E suite run with the production flag. Turn it off only to reach a dev server over plain HTTP
  through another host name.
- No `__Host-` prefix: it requires `Path=/` and an always-Secure cookie, which conflicts with the two choices above.

### CSRF — session-bound token in a header

- `POST`, `PUT`, `PATCH` and `DELETE` on protected routes must send `X-CSRF-Token: <token>`, else **403**. The token is
  `HMAC-SHA256(key = session token, "viper-csrf-v1")`: the server recomputes it from the cookie on each request
  (nothing stored, no server secret to manage), compares it in constant time, and a leaked CSRF token reveals nothing
  about the HttpOnly session token. It is returned by `POST /api/auth/login` and `GET /api/auth/session`; the SPA keeps
  it in memory only.
- Defence in depth: SameSite=Strict, and no CORS (a cross-origin page cannot read responses or send custom headers).
- Sign-in itself has no session yet: FastAPI's strict content type only parses `application/json` bodies, which an
  HTML form or a CORS-simple request cannot produce; a forged sign-in would anyway need the attacker's credentials.

### Throttling — in-process

Per client address, within a 15-minute sliding window: **5 failures for one email** and **20 failures in total**; past
either limit, sign-in answers **429** with `Retry-After`, even for the right password, until the oldest failure
leaves the window. Unknown emails are counted exactly like existing ones. A successful sign-in clears that email's
counter for that client (not the client total). State lives in memory (`LoginThrottle` on `app.state`).

Known limits, acceptable for a single-instance pilot: counters are per process and reset on restart; several
workers/instances would each count separately (move them to a table or Redis first); behind a reverse proxy the
client address must be the real one (see *Production*), otherwise all users share one bucket; the check and the
record are not one atomic step, so a burst of parallel attempts can overshoot a limit by at most the server's worker
thread count (40 by default) before being refused. Failures are not
capped per account across addresses, on purpose: a global per-account lock would let anyone lock the only user out;
distributed guessing is bounded by argon2's cost and the 12-character minimum.

### Protection at the router level

- `app/api/router.py` has two routers mounted under `/api`: `public_router` — the explicit allowlist
  (`GET /api/health`, `POST /api/auth/login`) — and `api_router`, whose router-level dependency `require_session`
  demands a live session (401) and, on unsafe methods, the CSRF token (403). **Every feature router is included in
  `api_router`** and is therefore protected without doing anything; FastAPI 0.141 keeps included routers live, so
  even a router added after the app is built inherits the guard.
- A 401 caused by an invalid/expired cookie also expires the cookie on the client.
- `GET /api/auth/session` (current user + CSRF token) is itself protected: 401 *is* the "not signed in" answer.
- `/api/openapi.json` and `/api/docs` stay public: they describe the (public) code, not data.
- `tests/test_route_protection.py` walks every route of the real app without a session and requires 401 everywhere
  except the allowlist, and pins the list of non-router routes.

### Actor context

`CurrentActor` (`app/api/dependencies.py`) builds `ActorContext(type=HUMAN, id=str(user.id),
display=user.display_name)` from the resolved session, never from the request. Routes pass it to services as their
`actor` argument; services snapshot it (ADR-0002).

### Bootstrap

`python -m app.cli create-user --email … --display-name …` creates the account, or resets its password (and revokes
its sessions) when the email exists. The password is prompted twice, or read from stdin with `--password-stdin` for
automation — never an argument (shell history, process list). No default account or password exists anywhere.

### Frontend

The SPA asks `GET /api/auth/session` once at load (`RequireAuth` guard; anonymous → `/login`, the requested URL kept
in history state, which a link cannot forge — no open redirect). The API client adds `X-CSRF-Token` on unsafe methods
and, on any 401 from an authenticated call, returns to `/login` with "Votre session a expiré". Sign-out calls the API
and drops every cached response.

## What production must configure

- **HTTPS** end to end at the reverse proxy, with `VIPER_SESSION_COOKIE_SECURE=true` (the default).
- Same-origin deployment (SPA and `/api` behind one host); do not enable CORS.
- Run uvicorn with `--proxy-headers --forwarded-allow-ips=<proxy address>` so throttling sees real client addresses.
- **One** application process, or move the throttle to a shared store before scaling out.
- Session timeouts appropriate to the operator's policy (`VIPER_SESSION_*`).
- Create the account on the server with the CLI (prompted password); never put a password in env files or CI.
- Optionally hide `/api/docs` (not required: it exposes no data).

## Consequences

- Revocation, expiry and "sign out everywhere" are plain SQL; no key management, no token denylist.
- One indexed lookup per authenticated request, plus at most one `UPDATE` per minute per session.
- Tests: the default `client` fixture is signed in (cookie + CSRF header), `anonymous_client` is not; routers added by
  later tasks keep working in tests without auth plumbing and are covered by the route walk automatically.
- The full-stack Playwright suite (real backend on `viper_e2e`) replaces the shell-only smoke (ADR-0001 amended).
- Replacing the password with an external identity provider (OIDC/SAML) later only changes how a `users` row is
  authenticated (e.g. an `external_subject` column); sessions, `CurrentActor` and every actor snapshot (`actor_id` =
  user UUID) stay as they are, and `internal_referents` are untouched.

## Alternatives considered

- **JWT access/refresh tokens** — stateless, but revocation needs a denylist (i.e. server state anyway); tokens kept in
  JS storage are exposed to XSS, and in a cookie they still need CSRF protection. No benefit for one same-origin SPA.
- **Signed cookie sessions** (itsdangerous/Starlette `SessionMiddleware`) — no table, but no server-side revocation
  before expiry and a signing secret to manage and rotate.
- **Double-submit cookie** — needs a JS-readable cookie and a secret to bind it to the session; the HMAC-of-session
  token gives the same binding with neither.
- **Custom header only** (`X-Requested-With`) — adequate with SameSite and no CORS, but not bound to the session.
- **Throttling in the database** — survives restarts and multiple workers, but adds a table, writes on every failure
  and cleanup; unnecessary for one process.
- **bcrypt / scrypt** — fine, but argon2id is the current OWASP/RFC 9106 recommendation and memory-hard.
- **Enterprise SSO now** — out of scope for the pilot (task file); the design above keeps it a local change.
