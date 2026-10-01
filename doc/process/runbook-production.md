# Runbook — production deployment (requirements, not a hosting decision)

VIPER V1 has **no chosen host** yet (open question #2): this page lists what any production deployment must provide
and the steps to install and upgrade it, so the hosting decision can be made against it. Nothing here was deployed
or verified on a real host; the commands are the ones verified locally (`runbook-local-dev.md`). Decisions still
open are listed at the end — they belong to the product owner and the operator, not to the code.

## Target shape

One small host (or VM/container) is enough for the pilot (one user, a few thousand prospects):

```
browser ──HTTPS──▶ reverse proxy ──▶ frontend/dist (static SPA, fallback to index.html)
                        └── /api ──▶ uvicorn, ONE process, 127.0.0.1:8042 ──▶ PostgreSQL ≥ 16
```

- **Same origin**: the SPA and `/api` are served under one host name; no CORS (ADR-0004). The session cookie is
  `Path=/api`, `SameSite=Strict`, `HttpOnly`, `Secure`.
- **One application process** (no `--workers`): the sign-in throttle is in memory and per process (ADR-0004). Scaling
  out first needs a shared throttle store.
- **PostgreSQL 16 or later** with the `unaccent` and `pg_trgm` extensions allowed (migrations `0005` and `0007`
  create them; both are *trusted* extensions since PostgreSQL 13, so the database owner may create them — check that
  the managed service allows them).

## Database roles

| Role | Rights | Created by |
|---|---|---|
| application role (e.g. `viper`) | owner of the VIPER database and its tables; runs the migrations; `CREATEROLE` only if it provisions the SQL reader itself | the DBA / hosting console |
| `viper_sql_reader` (`VIPER_SQL_READER_ROLE`) | `LOGIN` only, `CONNECTION LIMIT 10`, column `SELECT` grants on the exposed tables, read-only defaults and timeouts (ADR-0011) | `python -m app.cli provision-sql-reader`; without `CREATEROLE` the command prints the SQL for an administrator, then applies the grants |

`pg_hba.conf` (or the service's network rules) must let both roles connect from the application host. Roles belong
to the PostgreSQL cluster, not to the database: a restored dump does not carry them (see *Backups*).

## Configuration (`VIPER_*` environment variables)

Set them in the process environment (systemd unit, container env, secret store) — not in a committed file. A
`backend/.env` on the server is acceptable only with restrictive permissions.

| Variable | Production value |
|---|---|
| `VIPER_DATABASE_URL` | **secret**: `postgresql+psycopg://<app role>:<password>@<host>:<port>/<db>`; the default is the local Docker database |
| `VIPER_SQL_READER_PASSWORD` | **secret**, random, ≥ 24 characters; the default `viper_sql_reader` is a local-development value |
| `VIPER_SQL_READER_ROLE` | `viper_sql_reader` unless the DBA names it otherwise |
| `VIPER_SESSION_COOKIE_SECURE` | `true` (default) — HTTPS only |
| `VIPER_SESSION_IDLE_TIMEOUT_MINUTES` / `VIPER_SESSION_ABSOLUTE_TIMEOUT_HOURS` | 120 / 12 by default; per the operator's security policy |
| `VIPER_SQL_STATEMENT_TIMEOUT_MS` / `VIPER_SQL_MAX_ROWS` | 5000 / 1000 by default |
| `VIPER_IMPORT_MAX_FILE_MB` / `VIPER_IMPORT_MAX_ROWS` / `VIPER_IMPORT_MAX_COLUMNS` | 10 / 5000 / 100 by default; the proxy's body limit must be at least the file limit + 2 MiB |
| `VIPER_VERIFICATION_STALE_DAYS` | unset until product chooses the threshold (open question #9) |
| `VIPER_MONTHLY_CONTACT_TARGET` / `VIPER_MONTHLY_APPOINTMENT_TARGET` | 100 / 10 (informative Home targets) |
| `VIPER_RUNTIME_SETTINGS_PATH` | **secret file**: where the integration settings typed in Paramètres › Connexions are kept (S8) — the OpenAI key **in clear**. Under the service account's home, outside the checkout and the database backups (default `~/.viper/runtime-settings.json`, `0600` on POSIX; on Windows the profile's ACL applies). Refused inside the checkout |
| `VIPER_TOOLBOX_TOKEN_STORE_PATH` | **secret file**: the Toolbox OAuth token, same rules (default `~/.viper/toolbox-oauth.json`) |
| `VIPER_TOOLBOX_TIMEOUT_MS` / `VIPER_TOOLBOX_CLEANUP_INTERVAL_MS` | 20000 / 60000 by default (`0` = no cleanup worker; run the CLI instead) |
| `VIPER_CONTACT_DISPATCH_MAX_LATENESS_MS` / `…_CLAIM_TTL_MS` / `…_MAX_ATTEMPTS` / `…_RETRY_BASE_MS` | 6 h / 10 min (never below twice the Toolbox timeout) / 5 / 60 s by default |
| `VIPER_OPENAI_TRUST_ENV` | `true` only behind a corporate proxy / private CA (OpenAI calls then honour `HTTPS_PROXY`, `SSL_CERT_FILE`…) |

**Integration settings are set in the UI** (Paramètres › Connexions, S8), not here: OpenAI key / model / API address /
timeout / retries, booking link, default sender, CIRCOE Toolbox (« Se connecter à CIRCOE Toolbox »; built-in server
address `https://circoetoolbox-server-production.up.railway.app/mcp`, return address = the page's own), scheduled
sending frequency (off by default) and recipient allowlist. Each has an optional `VIPER_*` variable
(`backend/.env.example`) used only as a default — a value typed in the UI wins until « Rétablir la valeur par
défaut ». Anyone signed in to VIPER can replace these values (each change is audited, without the key): accepted for
the internal pilot by the Human on 2026-10-01; the secret-management process is to be revisited before a wider use.

`VIPER_TEST_DATABASE_URL` and the `VIPER_E2E_*` / `VIPER_WEB_PORT` / `VIPER_API_TARGET` variables are for development
and tests only.

## First installation

From a checkout of the release commit, with Python 3.14 and Node 24:

```bash
# Frontend: static files for the proxy
cd frontend && npm ci && npm run build            # → frontend/dist (the /_dev/ui showcase is not included)

# Backend
cd ../backend
python -m venv .venv && . .venv/bin/activate      # Windows: .venv\Scripts\Activate.ps1
pip install -r requirements.txt                   # runtime only (not requirements-dev.txt)
alembic upgrade head                              # schema, extensions, triggers
python -m app.cli provision-sql-reader            # reader role + grants (or have the DBA run the printed SQL)
python -m app.seed                                # optional: suggested roles/segments/categories (idempotent)
python -m app.cli create-user --email <pilot e-mail> --display-name "<Prénom Nom>"   # prompts for the password
```

The account is created on the server only: the password is typed at the prompt (12–1024 characters) and exists
nowhere else; re-running `create-user` with the same e-mail resets it and signs out every session.

## Running

```bash
uvicorn app.main:create_app --factory --host 127.0.0.1 --port 8042 \
  --proxy-headers --forwarded-allow-ips=<proxy address> --no-access-log
```

- Under a process manager (systemd, NSSM, container restart policy) with automatic restart; one process. The
  CIRCOE Toolbox's pending OAuth attempts live in that process (a restart during a connection: connect again) and
  its cleanup worker and the Contact dispatcher are threads of it (S6, S7); `python -m app.cli toolbox-cleanup
  --once` and `python -m app.cli contact-dispatch --once` run one pass by hand. A scheduled message leaves only while
  this process runs: stopped longer than the max lateness (6 h), it goes back to « Validé » without leaving. Stop the
  process gracefully (SIGTERM): the running pass finishes first.
- `--proxy-headers` with the proxy's address, so the sign-in throttle sees the real client address; otherwise every
  user shares one bucket.
- `--no-access-log`: access lines carry query strings such as `/api/search?q=<a name>`. If requests must be logged,
  log them at the proxy without the query string.
- Health for monitoring: `GET /api/health` → `200 {"status":"ok","database":"ok"}` (`503` when PostgreSQL is down).

## Enabling the Contact features (step by step)

Everything is off by default and is turned on from **Paramètres › Connexions**, one layer at a time, each verified
before the next — no restart. No real call to OpenAI, the Toolbox or Infomaniak was ever made during development
(fakes only): the first real calls are these steps.

1. **Sender and booking link**: card *Expéditeur* (indicative « De »), *Rédaction IA › Lien de prise de rendez-vous*.
2. **AI drafting**: card *Rédaction IA*: the API key and the model (the operator's choice; no default), *Enregistrer*,
   then *Tester la clé* (one `GET /models/{model}`, nothing generated). Open a test prospect in Contact, *Générer avec
   l’IA*, read the draft (never validated or sent by itself). The server log shows `mail_generation.succeeded` (no
   key, prompt or address in it).
3. **CIRCOE Toolbox, drafts only**: keep *Envoi programmé* on « Désactivé » (the default). *Se connecter à CIRCOE
   Toolbox* with the Infomaniak account **whose default mailbox must send** (VIPER must be opened over HTTPS — or on
   localhost — for the return address to be accepted). Validate a test message to an internal address: its draft
   appears in Infomaniak's Drafts; cancel it: the draft disappears
   ([`settings-connections.md`](../features/settings-connections.md) § Connecting for real).
4. **First real send, fenced**: *Envoi programmé › Adresses autorisées* = the internal test address (VIPER refuses any
   other recipient — `send_recipient_not_allowed`, back to « Validé »). Schedule the test message a few minutes ahead,
   then run **one pass by hand** at that time: `python -m app.cli contact-dispatch --once` (prints `sent=1`; it reads
   the settings saved from the UI). Check the mail in the recipient's inbox **and** in the mailbox's sent items, the
   message *Envoyé* in VIPER, nothing else sent. **Also check, right after the send, that the draft has left
   Infomaniak's Drafts folder and is no longer returned by `list_drafts`** — the reconciliation of unknown outcomes
   relies on it (« brouillon disparu = envoyé »); if the draft lingers (Infomaniak's undo-send delay), report it before
   going further. Note whether the Toolbox's answer carries `provider.etop` / `provider.cancelResource` (undo-send):
   VIPER ignores them today.
5. **Automatic sending**: *Envoi programmé › Fréquence* « Toutes les 30 secondes ». The card shows *Actif* and the last
   pass; the schedule confirmation says the mail will leave automatically. Repeat step 4 with the worker.
6. **Open to real prospects**: empty *Adresses autorisées*. From then on, watch *Envois non confirmés*; reconnect the
   Toolbox every 30 days (*À reconnecter*): while it is not connected nothing leaves, and a message more than 6 h
   late goes back to « Validé ».

Turning it off: *Fréquence* « Désactivé » stops automatic sending (drafts still created); *Se déconnecter…* forgets
the token and turns the whole Toolbox integration off (its workers stop).

## Reverse proxy

- **TLS** for the public host name, HTTP redirected to HTTPS, `Strict-Transport-Security` on every response.
- Serve `frontend/dist` with a fallback to `index.html` for client routes (`/prospection`, `/database/…`), long cache
  for `/assets/*` (hashed names), `no-cache` for `index.html`.
- Forward `/api/` to `127.0.0.1:8042` with `X-Forwarded-For` / `X-Forwarded-Proto`; request body limit ≥ 12 MiB on
  `/api/imports/*` (10 MiB workbook + multipart); read timeout ≥ 60 s (the Excel export of 20 000 prospects takes
  ≈ 20 s; V1 volumes take a few seconds).
- Headers on the SPA's HTML (the API sets its own, I-156): `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: no-referrer`, and a CSP to **validate on the real build before enforcing**, starting from
  `default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self'; connect-src 'self';
  frame-ancestors 'none'; base-uri 'self'; form-action 'self'` (React sets inline `style` attributes; the fonts and
  logos are self-hosted). Use `Content-Security-Policy-Report-Only` first.
- Optionally restrict `/api/docs` and `/api/openapi.json` (they expose no data, only the public code's schema).

## Upgrading

1. Take a backup (below) and stop the application process.
2. Check out the new release; `pip install -r requirements.txt`; `npm ci && npm run build`.
3. `alembic upgrade head`, then **`python -m app.cli provision-sql-reader`** — new tables or columns do not inherit the
   reader's grants (the console answers « Table non accessible » until then; it never exposes more).
4. Start the process, check `/api/health`, sign in.

Provisioning serializes itself across the cluster (an advisory lock in the `postgres` database, I-151); it needs
that database to accept connections from the application role, else it locks in the VIPER database only.

## Backups (decision open)

Nothing is decided: frequency, retention, location, encryption and restore tests belong to the hosting choice.
Facts to account for:

- The database is the only state: no uploaded file or export is stored server-side (ADR-0012, ADR-0013).
- A backup holds personal data **and the append-only audit log with full contact values** (I-27): it inherits the
  retention/anonymization policy below.
- `pg_dump` of the database does not contain roles or their settings: after a restore into a new cluster, create
  the application role, then run `provision-sql-reader` (and `create-user` if the `users` table was not restored).
- A restore must be tested at least once before the pilot relies on it.
- **Scheduled Contact messages after a restore** (S7): a backup taken before a send restores that message as
  « Programmé » — started as is, the dispatcher would send it again. Before starting the API on a restored database:
  `python -m app.cli contact-dispatch --hold-scheduled` (every scheduled, unclaimed message back to « Validé »,
  `dispatch_held`, audited); claimed ones are listed for a person to settle. People then reschedule what must leave.
  Keep *Envoi programmé* on « Désactivé » until it is done. VIPER has no restore command of its own.

## Retention, anonymization, erasure (decision open)

- Durations for prospects, audit events, import traces and logs are not decided (open question #2).
- Audit personal values are stored in full (`POLICY.personal_values = full`, I-27). Tightening it (`masked` /
  `omitted`) is one switch for new events; events already written need a reviewed, subject-scoped redaction
  migration (`subject_type` / `subject_id` make it targetable). The audit log rejects UPDATE/DELETE by trigger.
- Deleting a prospect cascades to its channels, tracking, sources and import traces, but keeps its audit events; an
  opposed (`do_not_contact`) prospect cannot be deleted without first lifting the opposition with a reason (I-12).

## Logging

- Application logs contain exception classes and row numbers only; the engine hides bound SQL values (I-156).
- A traceback of an unexpected database error can still quote a value from PostgreSQL's error *detail* (e.g. a
  unique violation): treat server logs as personal data (restricted access, bounded retention).
- Audit payloads are never written to logs; the SQL console records query hashes, never query texts (I-67).

## Operational limits to know

- Sign-in throttle: 5 failures per e-mail / 20 per client address per 15 minutes, in memory — reset by a restart,
  per process.
- Excel export: the whole base loaded in memory and written synchronously within the request (≈ 20 s at 20 000
  prospects, measured; memory not measured). Fine at V1 scale; a background job would be the next step far beyond
  it.
- Planner statistics: the whole-base statements and the export are planned without nested loops (ADR-0019, I-155), so
  a VACUUM racing a bulk import cannot make them quadratic; default autovacuum settings are fine.

## Open ops / legal decisions (product owner and operator)

1. Hosting provider, region, host name and TLS certificate management.
2. Backups: frequency, retention, off-site location, encryption, restore test cadence.
3. Retention and anonymization durations for prospects, audit events (and whether to switch audit personal values
   to `masked`/`omitted`), import traces and server logs.
4. Legal basis wording for imports and manual entries (defaults « Fichier historique Circoe — prospection B2B » and
   « Saisie manuelle — prospection B2B » are editable per import/entry).
5. Identity: CLI-created password account for the pilot; SSO/OIDC later only changes how a `users` row authenticates
   (ADR-0004).
6. More than one user or process: move the sign-in throttle to a shared store first.
7. Monitoring/alerting on `/api/health` and on failed imports (`import_batches.status = failed`).
