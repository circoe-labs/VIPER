# Task 04 — Implement secure single-user authentication and actor context

## Goal
Protect VIPER routes with secure pilot authentication and establish stable human actor identity for audit.

## Context
The source-of-truth requires one authenticated commercial user. Keep this deliberately small; internal referents are separate domain records.

## Coding Skill Requirement
Before editing code, load and follow `/caveman` and `/coding-guideline` from `~/ai/skills/`.

## Scope
### In Scope
- Secure login/session approach appropriate to chosen stack.
- Protected app routes/API.
- ActorContext available to mutation services.
- Logout/session expiry/error handling.
- Local/dev bootstrap without committing secrets.

### Out of Scope
- No RBAC matrix.
- No SSO enterprise project unless existing conventions make it trivial.
- Do not turn all internal referents into users.

## Dependencies
Tasks 01 and 03.

## Implementation Steps
1. Choose auth mechanism consistent with stack.
2. Add user/account/session minimal schema if needed.
3. Protect routes.
4. Expose actor identity to services.
5. Add tests and setup docs.

## Files Likely Touched
Auth config/routes/middleware/session storage, actor-context abstraction, tests.

## Architecture Constraints
Passwords/secrets never stored/logged insecurely. Use framework best practices. Actor identity must be available server-side, not trusted from client payload.

## Testing Requirements
Unauthenticated access blocked, login/logout/session tests, actor propagation test, no-secret lint/config review.

## Acceptance Criteria
- App requires authentication.
- One pilot user can operate it.
- Mutations can identify the authenticated human actor.
- Internal referents remain separate.

## Documentation Updates
Document local/admin setup and secret handling.

## Handoff Notes
Exact production identity provider can be revisited later without changing domain referent records.

## Implementation report

Implemented on branch `claude` (main worktree). Design: [ADR-0004](../../../../doc/adr/0004-authentication-sessions.md);
decisions I-23…I-25 in `doc/product/decision-log.md`.

### What was done
- **Schema** (migration `0003_authentication`): `users` (email unique lowercase, display name, argon2id hash,
  timestamps + `set_updated_at` trigger) and `user_sessions` (user FK CASCADE, SHA-256 `token_hash` unique,
  `created_at`, `last_seen_at`, `expires_at`, `revoked_at`). No link to `internal_referents`; nothing limits
  `users` to one row.
- **Credentials** (`app/core/security.py`): argon2id via `argon2-cffi==25.1.0` (RFC 9106 low-memory: t=3, m=64 MiB,
  p=4), dummy-hash verification for unknown emails (same message, status and cost), rehash on login when parameters
  change; 256-bit session tokens stored as SHA-256; CSRF token = HMAC-SHA256 keyed by the session token.
- **Sessions** (`app/services/auth.py`): idle (120 min) and absolute (12 h) expiry from Settings, `last_seen_at`
  bumped at most once a minute, new token at every sign-in (previous cookie's session revoked), logout revokes,
  dead sessions purged at sign-in, password reset revokes all sessions.
- **Throttling** (`app/services/login_throttle.py`): in-process sliding window, 5 failures per (client, email) and
  20 per client in 15 min → 429 + `Retry-After`, even with the right password; unknown emails counted alike.
- **API**: `public_router` (allowlist: `GET /api/health`, `POST /api/auth/login`) and `api_router` whose dependency
  `require_session` guards every other route (401 without a live session — an invalid cookie is also expired — and
  403 without the CSRF header on POST/PUT/PATCH/DELETE). Routes: `POST /api/auth/login`, `GET /api/auth/session`,
  `POST /api/auth/logout`. Cookie `viper_session`: HttpOnly, Secure (setting, default on), SameSite=Strict,
  Path=/api. Stray `/docs/oauth2-redirect` route removed; OpenAPI schema/docs stay public.
- **Actor**: `CurrentActor` dependency → `ActorContext(HUMAN, str(user.id), display_name)` from the session;
  `app/core/actor.py` documents it.
- **Bootstrap**: `python -m app.cli create-user --email … [--display-name …] [--password-stdin]` (create or reset;
  prompted twice; never an argument). `.env.example` gains only non-secret session settings.
- **Frontend**: `/login` page (French copy, Neon Command card, theme lockup via `BrandLogo`, labelled fields with
  autocomplete, custom French validation, generic error alert, throttling and network messages, busy button,
  password cleared + focused after a refusal, theme switch); `RequireAuth` guard (session probe at load, loading and
  server-unreachable states, anonymous → `/login` keeping the requested URL in history state, any 401 → back to
  login with "Votre session a expiré"); header user zone `UserMenu` (initials, name, `Se déconnecter`, failure
  message); the API client sends `X-CSRF-Token` on unsafe methods (token in memory only) and sign-out clears every
  cached response.
- **E2E**: Playwright is full stack — backend on 8044 against `viper_e2e`, Vite on 5180 through
  `e2e/vite.config.e2e.ts` (`vite.config.ts` untouched); global setup rebuilds `viper_e2e` through the migrations
  (refuses names not ending in `_e2e`) and creates `pilote.e2e@example.com` with the real CLI and a random per-run
  password. `viper_e2e` was created in the running container and added to `docker/postgres/init/`. The CI `e2e` job
  now has a PostgreSQL service and installs the backend requirements. Existing shell/design specs sign in through
  the API first.

### Files
- Backend: `app/core/{security,config,actor}.py`, `app/models/users.py` (+ `common.py` now shares `EMAIL_FORMAT`),
  `app/repositories/users.py`, `app/services/{auth,login_throttle}.py`,
  `app/api/{dependencies,session_cookie,router}.py`, `app/api/routes/auth.py`, `app/main.py`, `app/cli.py`,
  `migrations/versions/0003_authentication.py`, `requirements.txt`, `.env.example`; tests `test_auth.py`,
  `test_route_protection.py`, `test_login_throttle.py`, `test_cli.py`, fixtures in `conftest.py` / `builders.py` /
  `support.py`.
- Frontend: `src/api/client.ts`,
  `src/auth/{session.ts,currentUser.ts,loginState.ts,RequireAuth.tsx,LoginPage.tsx,auth.css}`,
  `src/shell/{UserMenu.tsx,AppShell.tsx,shell.css}`, `src/ui/icons.tsx` (`LogOutIcon`), `src/routes.tsx`,
  `src/test/{render.tsx,setup.ts}`; tests `client.test.ts`, `LoginPage.test.tsx`, `RequireAuth.test.tsx`,
  `UserMenu.test.tsx`; `playwright.config.ts`, `e2e/{env,global-setup,session,vite.config.e2e}.ts`,
  `e2e/auth.spec.ts`, `tsconfig.node.json` (`allowImportingTsExtensions` for the E2E Vite config).
- Infra/docs: `.github/workflows/ci.yml`, `docker/postgres/init/02-create-e2e-database.sql`, `docker-compose.yml`
  (comment), `scripts/verify.py` (docstring), `README.md`, ADR-0004 (new), ADR-0001 (amendment line),
  `doc/architecture/{security-and-privacy,overview,data-model}.md`, `doc/design/design-system.md`,
  `doc/process/{runbook-local-dev,testing-strategy}.md`, `doc/product/decision-log.md`.

### Tests run
- `python scripts/verify.py --e2e` → all green: privacy guard OK, ruff check/format OK, mypy strict OK (65 files),
  **pytest 115 passed** (75 before + 40 new), eslint/tsc OK, **vitest 207 passed** (13 files), vite build OK,
  **Playwright 12 passed** (5 new auth specs + the 7 existing shell/design specs, now signed in).
- Backend coverage: route walk (every non-allowlisted route → 401 without a session; non-router routes pinned to the
  OpenAPI schema/docs); a router added to `api_router` later is protected automatically; login OK; unknown email vs
  wrong password (same body/status, one argon2id verification each); JSON-only login; token rotation; rehash;
  throttling (account locked even for the right password, unknown emails, reset on success, fake-clock unit tests of
  the window/per-client limit/pruning); idle and absolute expiry; activity keeps the session alive; `last_seen_at`
  write resolution; timeouts from Settings; logout revocation + cookie cleared + replay refused; unknown cookie
  rejected and expired; cookie flags (HttpOnly, Secure, Strict, Path, Max-Age; Secure can be disabled); CSRF on
  POST/PUT/PATCH/DELETE (missing, empty, forged, another session's token); GET without CSRF; argon2id parameters;
  password/hash never in responses, headers, `repr` or `app` logs; actor propagation to `save_contact_tracking`
  (forged payload actor ignored); CLI create/reset/mismatch/invalid input.
- Frontend coverage: login form (lockup, labels, autofocus, French validation, generic 401 error, 429 message, busy
  state, deep-link continuation, already-signed-in redirect); guard (anonymous redirect, session restore, global 401
  → expired notice → back to the same page, server unreachable + retry); sign-out (CSRF header, cache cleared,
  notice, next sign-in starts at Accueil, failed sign-out reported); API client (CSRF only on unsafe methods, 204,
  401 listeners).
- E2E: wrong password; sign-in → shell; reload keeps the session; sign-out → login and `/api/auth/session` 401
  (server-side revocation); deep link restored; cookie flags as seen by the browser (`document.cookie` empty);
  light-theme lockup. Screenshots `login-dark.png`, `login-light.png`, `shell-signed-in.png` in
  `frontend/test-results/screenshots/` (git-ignored).

### Deviations / decisions
- I-23 (auth design; SameSite **Strict** instead of Lax; session-bound HMAC CSRF token; in-process throttle), I-24
  (account management CLI-only, no roles, OpenAPI docs public), I-25 (full-stack Playwright with a dedicated E2E
  database and ports; backend `client` fixture signed in by default). ADR-0001 amended accordingly.
- FastAPI 0.141 keeps included routers live (`_IncludedRouter` entries in `app.routes`); the route walk flattens them
  with `fastapi.routing.iter_route_contexts`.

### Open points / risks
- Throttling is per process (documented limits: a restart resets it, several workers would each count, a reverse
  proxy must forward real client addresses, parallel bursts can overshoot by the worker-thread count).
- The dev database needs `alembic upgrade head` and `python -m app.cli create-user …` before the running app can be
  used; not done here (no password to invent on the operator's behalf).
- Task 11 merges after this slice: its routers must be included in `api_router` (then protected automatically and
  covered by the route walk); its backend tests using `client` are signed in; its frontend tests using `renderApp`
  get a seeded session. Decision IDs I-23…I-25 may need renumbering if Task 11 used the same ones.
- CI has not run on GitHub (nothing pushed); the changed CI `e2e` job is unverified remotely.
