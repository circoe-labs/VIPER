# Settings — Connexions: integrations set in the browser (Contact port S6, S7, S8, S9)

**Paramètres › Connexions** (`/settings/connections`) is where VIPER is connected to the outside, **entirely from the
UI** (S8, Human requests of 2026-10-01: « configurer mes API KEY directement dans le navigateur », then « me connecter
à CIRCOE Toolbox depuis la configuration VIPER »). Four cards, each saving its own fields, applied at once without a
restart:

- **Rédaction IA (OpenAI)** — API key (write-only), model (no default), booking link; *Paramètres avancés*: API
  address, timeout, retries. *Tester la clé* checks the saved key and model.
- **Expéditeur** — the « De » pre-filled in new messages (indicative: the Toolbox sends from the account's default
  mailbox).
- **CIRCOE Toolbox** (S6) — **« Se connecter à CIRCOE Toolbox »** works out of the box (built-in server address, the
  page's own return address); *Paramètres avancés*: server address, return address; *Se déconnecter…*.
- **Envoi programmé** (S7, S9) — one switch *Envoi automatique des mails programmés*, **on by default**; allowlist of
  recipients; the dispatcher's state and the scheduled messages that will not leave; *Paramètres avancés*: *Délai
  maximal avant envoi* (the dispatcher's period, 30 s by default).

Through the Toolbox (MCP server over HTTP, OAuth 2.1) a validated Contact/R1/R2 message becomes a draft in the linked
**Infomaniak** mailbox and an invalidated or cancelled one loses it: [`contact.md`](contact.md) § CIRCOE Toolbox.
Decision: C-20 in the decision log. Tests and E2E use local fakes only — no real call to OpenAI, the Toolbox or
Infomaniak was ever made (Contact port P6).

## Prompt initial (`/settings/prompt`)

A separate tab of Paramètres holds the **initial prompt**: the task brief the AI receives **before anything else** when it
drafts a Contact / R1 / R2 e-mail (what it is, who it writes to and why, how the three messages fit together). It is the
setting `contact_initial_prompt` (≤ 8 000 characters, saved like the other integration settings: private file, revision,
audit event `settings.integrations_changed`); unset, the built-in `DEFAULT_INITIAL_PROMPT` applies. The page shows the
built-in text while none is saved; *Rétablir le texte par défaut* puts it back and saving it unchanged stores nothing
(`null`). An empty prompt is refused. The mandatory rules (facts only, format, booking link, JSON) and the client card
follow it and are **not** editable. A change applies to the next generation, without a restart.
`GET /settings/integrations` also returns `initial_prompt_default` (the built-in text).

## Integration settings (S8) — `app/services/runtime_settings.py`, `app/services/integration_runtime.py`

**Editable here**: `openai_api_key` (secret), `openai_model`, `openai_base_url`, `openai_timeout_ms`,
`openai_max_retries`, `contact_booking_url`, `default_outbound_email`, `toolbox_mail_enabled`, `toolbox_mcp_url`,
`toolbox_oauth_redirect_uri`, `contact_dispatch_enabled`, `contact_dispatch_interval_ms`, `infomaniak_send_allowlist`. Everything else (database,
sessions, token store, SQL reader, import limits, dispatcher tuning, `VIPER_OPENAI_TRUST_ENV`) stays environment-only.

- **Storage**: a private JSON file outside the database (never in a backup, the explorer or the SQL console) and
  outside the checkout (refused by `Settings`): `VIPER_RUNTIME_SETTINGS_PATH`, default `~/.viper/runtime-settings.json`.
  Atomic write (temporary file + `os.replace`, shared with the token store: `app/core/private_file.py`), directory
  `0700`, file `0600` — **on Windows these modes are ignored**: the file inherits the profile's ACL. **The OpenAI key
  is stored in clear** in it: accepted for the internal pilot (Human decision of 2026-10-01), to be revisited, as is
  the fact that anyone signed in to VIPER can replace it.
- **Precedence**: a value saved here > the `VIPER_*` variable > the built-in default. Each field says its source
  (« Défini ici par … le … » / « Valeur fournie par la configuration du serveur » / « Valeur par défaut ») and, when
  set here, offers « Rétablir » (tooltip: the value it gives back; `null`). **An emptied field is « Rétablir »** too
  (`""` is never stored: QA M2 — an emptied return address now lets the page send its own). The UI never asks to set
  a variable or to restart.
- **The key follows its API address only** (QA M1): a key saved here is stored with the API address of that save
  (`bound_base_url`) and is never sent to another one; the environment's key only goes to the environment's / the
  default address. Changing (or resetting) the API address without typing the key again in the same save is 422
  `invalid`, `field: openai_api_key`, `reason: required_with_base_url`; the page warns under the key field and opens it.
- **The Toolbox token follows its server only** (QA B1): the token is bound to the resource it was issued for — a
  token for another address counts as « not connected » and is never sent (status, `access_token`, the workers);
  changing or resetting `toolbox_mcp_url` deletes the token (audit `toolbox.forgotten`, reason
  `toolbox_mcp_url changed`) and stops the workers; the page asks first (« Changer l’adresse du serveur ? … déconnecte
  la Toolbox »). A connection started before a rebuild of the integration still finishes when the server and return
  addresses did not change, else its return is 409 `toolbox_connection_interrupted` (« connexion interrompue par un
  changement de réglage, recommencez »). « Se déconnecter » empties the token file even while the integration is off.
- **Validation**: the merge is validated by `Settings.model_validate` — the **same validators as at startup**, not a
  copy (http(s) URLs; https or http on loopback for the Toolbox URLs; allowlist syntax; ranges; a model whenever a key
  is set). A refusal is 422 `invalid` with the `field` (never the submitted value); the page shows French copy under
  the field (`settings/integrationsModel.ts`).
- **Concurrency**: `version` (the file's revision) is sent back with every save; a stale one is 409 `conflict` (the
  page reloads and says so).
- **Write-only secret**: the API answers `{set, last4, source, updated_at, updated_by}` for the key, never the key; it
  is not in a log line, an audit event or an error (`RuntimeFile.__repr__` hides values; validation errors are
  rebuilt without `input`). The page: an empty password field with the placeholder « •••• 1234 (enregistrée) »,
  *Remplacer*, *Effacer…* (confirmation; a key set here only).
- **Audit**: `settings.integrations_changed` (entity `integration_settings`): the changed fields with before/after
  values, except the key, recorded in the reason as `openai_api_key: replaced|removed`. `api_key` is also a secret
  fragment of the audit policy. A save that changes nothing is not audited.
- **Unreadable file**: reported (`load_error`: `unreadable` | `invalid`), ignored until the next save (the API still
  starts); the page shows a warning. A value that breaks a rule at startup is dropped **alone** (`load_dropped` names
  it; a key saved without a model or bound to another address drops with it), the others apply.
- **Unwritable file**: 503 `settings_storage_unavailable` (« Le fichier des réglages ne peut pas être écrit… »);
  nothing is saved or applied.
- **Live application** (`IntegrationRuntime`, `app.state.integrations`): `app.state.settings` is replaced by the new
  effective settings (every route reads it per request: OpenAI client, booking link, default sender, flags of the
  mail editor); a change of the Toolbox switch or URLs rebuilds `app.state.toolbox` (the token file is kept; an OAuth
  flow started but not finished is lost); the cleanup and dispatch workers run **only while the Toolbox is
  connected** — started at startup if it already is or right after the OAuth return, restarted when the dispatch
  settings change, stopped by *Se déconnecter*. The dispatcher also needs the switch on (`contact_dispatch_enabled`,
  default `true`) and a positive interval (default 30 s): with nothing chosen, connecting the Toolbox starts it (S9). Stopping waits for a running pass (bounded by the Toolbox timeout).
  One lock held around the save **and** the switch (QA m6: the file, `app.state.settings` — which every route,
  `GET /settings/integrations` included, reads — and the integration change together), one process (as already
  required by the Toolbox and the login throttle); the CLI (`--once`) reads the same file.

### API — `/api/settings/integrations` (session + CSRF, a person only)

| Method & path | Body | Answer |
|---|---|---|
| `GET /settings/integrations` | — | `{version, updated_at, updated_by, load_error, storage_path, fields: {<name>: {value, source, fallback, updated_at, updated_by}}, openai_api_key: {set, last4, source, updated_at, updated_by}, generation_available, toolbox: {enabled, state, configured}, dispatch: {running, active, reason, scheduled_count, overdue_count}}` |
| `PUT /settings/integrations` | `{version, <field>: value or null, openai_api_key?: string or null}` (unknown fields: 422) | same as GET |
| `POST /settings/integrations/openai/check` | — | `{ok, code, model, elapsed_ms}` — one `GET {base_url}/models/{model}` with the saved key (nothing generated, ≤ 15 s, no retry); codes `ai_not_configured`, `ai_auth_failed`, `ai_model_not_found`, `ai_rate_limited`, `ai_timeout`, `ai_upstream_error` |

## States

| `state` | Badge | Meaning |
|---|---|---|
| `disabled` | *Désactivée* | the integration is off (the default, or after *Se déconnecter*): nothing leaves VIPER. *Se connecter à CIRCOE Toolbox* turns it on. |
| `not_configured` | *Non configurée* (warning) | on, but the server address was emptied — the card names it in its own words and opens *Paramètres avancés*. |
| `disconnected` | *Non connectée* | on and configured, nobody connected. *Se connecter à CIRCOE Toolbox*. |
| `connected` | *Connectée* (success) | a usable token until `expires_at`: *Valable jusqu’au …*, *Connectée par*, *Depuis le*, the Toolbox origin. *Reconnecter*, *Se déconnecter…*. |
| `expired` | *À reconnecter* (warning; also on the section tab) | the 30-day token ended, or the Toolbox refused it (401: archived member, rotated secret). |

The card also shows the **last failure** (date + French reason of the `toolbox_*` code), the **obsolete drafts still
to delete** in Infomaniak (and how many failed at least once — retried automatically) and the **limitations**: the
sender is the account's default mailbox (VIPER's *De* is not transmitted), 30 days without automatic renewal, one
connection for the whole VIPER, « Se déconnecter » is VIPER-side only (no revocation in the Toolbox). The sender rule and
the single server-side connection renewed every 30 days were **accepted by the Human on 2026-10-01** for the pilot.

## OAuth flow (`app/services/toolbox/oauth.py`, port of the reference `toolboxAuth.ts`)

1. **Se connecter à CIRCOE Toolbox** → `POST /api/settings/toolbox/connect` (S8: turns the integration on and
   saves the page's return address first) (session + CSRF, the signed-in person): discovery
   (RFC 9728 `/.well-known/oauth-protected-resource` — its `resource` must equal `VIPER_TOOLBOX_MCP_URL` — then
   RFC 8414 metadata of the first authorization server; PKCE S256 required), **dynamic client registration**
   (RFC 7591, public client `VIPER`, `token_endpoint_auth_method=none`, kept in the token file and reused while the
   issuer and redirect URI stay the same), a **single-use `state`** (32 random bytes, 30 min, bound to the person's
   user id, in memory — the API runs as one process) and a PKCE verifier. Answer `{authorization_url}`: `/authorize`
   with `response_type=code`, `client_id`, `redirect_uri`, `code_challenge` (S256), `scope=mail` (least privilege),
   `resource` (RFC 8707) and `state`. The page sends the browser there (*Ouverture de la Toolbox… n s*).
2. At the Toolbox, the person signs in at Infomaniak (OIDC) and pastes a **personal Infomaniak API token** (Mail).
3. The Toolbox redirects the browser to `VIPER_TOOLBOX_OAUTH_REDIRECT_URI` = **this SPA page** with `code`, `state`,
   `iss` (or `error`). The page posts them once to `POST /api/settings/toolbox/callback` (*Finalisation de la
   connexion… n s*), removes them from the address bar and says the outcome (*CIRCOE Toolbox connectée jusqu’au …* or
   *Connexion à la Toolbox impossible : …*).
4. The API checks the `state` (known, not expired, **same VIPER user** — someone else's state is refused without
   being consumed, so it cannot be burnt; the owner's state is consumed even when the return is refused), `error`
   (`access_denied` → `toolbox_access_denied`), `iss` (RFC 9207, required when the server announces it), then
   exchanges the code at `/token` (`authorization_code` + `code_verifier` + `resource`): a Bearer token with the
   `mail` scope, stored with its expiry; audit `toolbox.connected`.

**Metadata endpoints** (`authorization_endpoint`, `token_endpoint`, `registration_endpoint`, the issuer) must pass
the same rule as the settings — https, or http on the loopback only — before VIPER calls them or sends the browser
there (else 422 `toolbox_rejected`, recorded as the last error); the page also follows only an http(s)
authorization URL (`lib/browser.ts`).

**Why the return lands on the SPA, not the API**: the session cookie is `SameSite=Strict` and scoped to `/api`; a
redirect initiated by the Toolbox's site reaches an API URL **without** it. The SPA page loads without the cookie,
then its own same-origin call carries the session and the CSRF token. So no route was added to the public allowlist,
and the `state` is additionally bound to the person who clicked. (The reference used a public API callback
authenticated by the `state` alone.)

**Expiry and refresh**: the Toolbox issues no refresh token (`grant_types_supported: ["authorization_code"]`); at
expiry (minus one minute) or on a 401 the token is marked invalidated → *À reconnecter*. A standard `refresh_token`
grant is used only when a server offers one (tested with the fake), never assumed.

**Se déconnecter…** → confirmation (*Retour* focused) → `POST /api/settings/toolbox/forget`: the token, who
connected and the last error are deleted from the file (the client registration stays); audit `toolbox.forgotten`;
then the integration is turned off (S8: `toolbox_mail_enabled` saved `false`, workers stopped).
The Toolbox has no revocation endpoint: the deleted token expires by itself at its end date.

## Token storage (`app/services/toolbox/token_store.py`)

- A JSON file, **never the database** (the database is copied by backups and readable by the Database Explorer and
  the SQL console): `VIPER_TOOLBOX_TOKEN_STORE_PATH`, default `~/.viper/toolbox-oauth.json`; a path **inside the
  repository checkout is refused at startup**.
- Directory created `0700`, file `0600`, written atomically (temporary file in the same directory + `os.replace`). On
  Windows the modes are ignored: the file inherits the ACL of the user profile — keep it under the service account's
  profile.
- Unreadable or malformed file = not connected (logged as a warning, never a crash).
- Concurrency: one lock serializes the read-modify-writes **within a process** (the API, which runs as one process,
  and its cleanup worker). A CLI `toolbox-cleanup --once` run beside the API is a second process: both only rewrite
  the file atomically, and the CLI writes only when the Toolbox refuses the token (marking it to reconnect), so the
  worst race is a lost « à reconnecter » mark that the next refused call sets again. No cross-process lock file.
- Tokens are excluded from `repr`, never logged, never returned by an API (no route accepts or returns one), never
  sent to the browser.

The Toolbox card (S9, Human request) has two more buttons when the connection exists. **Méthodes autorisées** flips the
card's body to the allowed MCP methods (name in mono, title, description; a scrollable list, `max-height: 20rem`,
*N méthodes autorisées pour cette connexion*, `aria-pressed`), **Retour à la connexion** flips back. **Actualiser**
(always shown) reads the state again and, with the methods shown, asks the Toolbox for them again (it may have changed
on its side); it does not renew the token. A failed read shows *Méthodes indisponibles : <reason>* in the card.

## API — `/api/settings/toolbox` (session + CSRF, `api_router`; registered before `/settings/{taxonomy}`)

| Method & path | Body | Answer |
|---|---|---|
| `GET /settings/toolbox` | — | `ToolboxStatus` |
| `GET /settings/toolbox/tools` | — | `{tools: [{name, title, description}]}` — the MCP methods the connection allows, read live (`tools/list`, first page; also proves the link works). 503/502/504 `toolbox_*` as elsewhere |
| `POST /settings/toolbox/connect` | `{redirect_uri?}` — the page's own `/settings/connections` address (S8) | `{authorization_url}`; first turns the integration on and saves the return address (`auto`: replaced by a later connection from another address, unless one was typed in *Paramètres avancés* or the environment sets it; same https/loopback rule, else 422 `invalid` field `toolbox_oauth_redirect_uri`) |
| `POST /settings/toolbox/callback` | `{state, code, iss, error}` (strings; unknown fields ignored) | `ToolboxStatus` |
| `POST /settings/toolbox/forget` | — | `ToolboxStatus` — *Se déconnecter* (S8): forgets the token **and** turns the integration off (workers stopped) |

```json
{
  "enabled": true, "state": "connected", "configured": true, "connected": true, "missing": [],
  "toolbox_origin": "https://toolbox.example", "connected_at": "…", "connected_by": "Prénom Nom",
  "expires_at": "…", "account_label": null, "last_error": {"code": "toolbox_access_denied", "at": "…"},
  "cleanups": {"pending": 2, "failing": 1},
  "dispatch": {"running": true, "active": true, "interval_seconds": 30.0, "last_pass_at": "…", "last_outcome": "ok",
               "scheduled": 3, "unconfirmed": 0}
}
```

`account_label` is always null: the Toolbox's answers name no mailbox. `missing` holds setting names, never values
(the page translates them). `dispatch` (S7) is the scheduled sending: `running` = the dispatcher thread runs in this
API process (Toolbox connected, switch on, interval > 0); `active` = and the Toolbox is connected, so a scheduled
message really leaves; `last_pass_at` / `last_outcome` (`ok`, `error` — the traceback is in the server log, null before
the first pass, per process); `scheduled` = messages in « Programmé », `unconfirmed` = those whose send is unconfirmed
(a person settles them in Contact).

Refusals (`{detail: {code, message}}`): 503 `toolbox_not_configured`; 502 `toolbox_unavailable` / 504
`toolbox_timeout` (discovery, registration or token exchange); 422 `toolbox_rejected` (PKCE S256 missing, registration
refused); 400 `toolbox_state_invalid`, 403 `toolbox_access_denied`, 400 `toolbox_authorization_failed`, 400
`toolbox_issuer_mismatch`, 502 `toolbox_token_exchange_failed`, 422 `toolbox_scope_missing`. Every failure of
*connect* and *callback* is recorded as `last_error` (code + time) and logged with its code
(`toolbox.connect_failed code=…`); success is logged too (`toolbox.connected`). The browser gives up after 90 s.

## Front end

`frontend/src/settings/ConnectionsSection.tsx` (the section, the Toolbox card, the OAuth return, the confirmation),
`settings/IntegrationCards.tsx` (card shell, *Rédaction IA*, *Expéditeur*, *Envoi programmé*, the Toolbox's advanced
form, the write-only key field, the per-field source/reset hint), `settings/integrationsModel.ts` (form values,
French refusals, sources), copy of the Toolbox in `settings/toolboxCopy.ts` (states, `toolbox_*` reasons,
limitations — shared with the Contact editor), `api/integrations.ts` and `api/toolbox.ts`. Existing DA only: each card
is `.settings-connection` (canvas background inside the surface panel, accent-soft icon tile, `StatusBadge`), fields
are `ui/fields` (`TextField`, `SelectField`, `TextAreaField`, `FieldFrame` for the key), one primary button per card
(*Enregistrer*; in the Toolbox card *Se connecter à CIRCOE Toolbox*, its advanced save being secondary), a native
`<details>` for *Paramètres avancés*, `FeedbackBanner` for the outcome, confirmations in `Modal`. Waits show a live
counter (*Enregistrement… n s*, *Test en cours… n s*, *Ouverture de la Toolbox… n s*) and have a deadline (60 s,
30 s, 90 s). A save refreshes the Toolbox state and the mail editor's flags (AI available, default sender).

The **Envoi programmé** card (S9, Human request « je ne comprends pas ce paramètre ») replaces the S8 frequency select
by one `Switch` *Envoi automatique des mails programmés* (`role="switch"`, saved as soon as it is toggled), checked by
default, with one plain line: « VIPER envoie chaque mail programmé à l’heure choisie (à 30 secondes près) via CIRCOE
Toolbox. » Off = `contact_dispatch_enabled: false` (no worker); on again with an interval of 0 (set by the server)
also sends 30 s. The period is *Délai maximal avant envoi (secondes)* in the card's collapsed *Paramètres avancés*
(1 to 3 600 s, checked in the page before the save). The card shows its badge (*Actif* success / *En attente*
warning: switched on but the Toolbox is not usable / *Désactivé* neutral), one sentence (`dispatchSentence`, naming
the reason while waiting), and — when the sending is inactive and messages are scheduled — a warning line « N
messages programmés ne partiront pas (M ont déjà dépassé leur heure) tant que l’envoi automatique est inactif. »
(`dispatchBacklog`, from `GET /settings/integrations` → `dispatch`), then *Dernière passe*, *Messages programmés*
and, when there are some, *Envois non confirmés* (« à trancher dans Contact »).

## Connecting for real (operator)

1. Open VIPER over HTTPS (or on localhost): the return address must pass the https/loopback rule.
2. Paramètres › Connexions › *Se connecter à CIRCOE Toolbox* (the built-in server address is
   `https://circoetoolbox-server-production.up.railway.app/mcp`, handoff docs/07; change it only in *Paramètres
   avancés*); sign in at Infomaniak and paste a personal API token with the Mail scope **of the mailbox that must
   send** (the sender is that account's default mailbox).
3. Validate a test message to an internal address and check the draft in Infomaniak's Drafts folder; cancel it and
   check it disappears.
4. Reconnect every 30 days (the tab says *À reconnecter*).
5. Scheduled sending (S7): see [`runbook-production.md`](../process/runbook-production.md) § *Enabling the Contact
   features* — the sending starts with the connection (S9); for a first cautious test, restrict *Adresses
   autorisées* to an internal address, or switch *Envoi automatique des mails programmés* off and run one pass by
   hand. Scheduled messages whose time passed while it was off leave at the next pass if they are less than 6 h
   late; beyond that they go back to « Validé » (`dispatch_overdue`) and must be scheduled again — never sent late.
