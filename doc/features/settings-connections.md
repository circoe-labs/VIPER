# Settings — Connexions: the CIRCOE Toolbox (Contact port S6)

**Paramètres › Connexions** (`/settings/connections`) connects VIPER to the **CIRCOE Toolbox** (MCP server over HTTP,
OAuth 2.1), through which a validated Contact/R1/R2 message becomes a draft in the linked **Infomaniak** mailbox and
an invalidated or cancelled one loses it. What happens to the messages: [`contact.md`](contact.md) § CIRCOE Toolbox.
Sending (`send_draft`) is S7. Decision: C-20 in the decision log. **Off by default**; tests and E2E use local fakes
only — no real call to the Toolbox or Infomaniak was ever made (Contact port P6).

## States

| `state` | Badge | Meaning |
|---|---|---|
| `disabled` | *Désactivée* | `VIPER_TOOLBOX_MAIL_ENABLED` is false: nothing leaves VIPER. No action. |
| `not_configured` | *Non configurée* (warning) | enabled, but `VIPER_TOOLBOX_MCP_URL` and/or `VIPER_TOOLBOX_OAUTH_REDIRECT_URI` unset — the card names them. |
| `disconnected` | *Non connectée* | configured, nobody connected (or forgotten). *Connecter la Toolbox*. |
| `connected` | *Connectée* (success) | a usable token until `expires_at`: *Valable jusqu’au …*, *Connectée par*, *Depuis le*, the Toolbox origin. *Reconnecter*, *Oublier la connexion…*. |
| `expired` | *À reconnecter* (warning; also on the section tab) | the 30-day token ended, or the Toolbox refused it (401: archived member, rotated secret). |

The card also shows the **last failure** (date + French reason of the `toolbox_*` code), the **obsolete drafts still
to delete** in Infomaniak (and how many failed at least once — retried automatically) and the **limitations**: the
sender is the account's default mailbox (VIPER's *De* is not transmitted), 30 days without automatic renewal, one
connection for the whole VIPER, « Oublier » is VIPER-side only (no revocation in the Toolbox).

## OAuth flow (`app/services/toolbox/oauth.py`, port of the reference `toolboxAuth.ts`)

1. **Connecter la Toolbox** → `POST /api/settings/toolbox/connect` (session + CSRF, the signed-in person): discovery
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
4. The API checks the `state` (known, not expired, **same VIPER user**, consumed even when refused), `error`
   (`access_denied` → `toolbox_access_denied`), `iss` (RFC 9207, required when the server announces it), then
   exchanges the code at `/token` (`authorization_code` + `code_verifier` + `resource`): a Bearer token with the
   `mail` scope, stored with its expiry; audit `toolbox.connected`.

**Why the return lands on the SPA, not the API**: the session cookie is `SameSite=Strict` and scoped to `/api`; a
redirect initiated by the Toolbox's site reaches an API URL **without** it. The SPA page loads without the cookie,
then its own same-origin call carries the session and the CSRF token. So no route was added to the public allowlist,
and the `state` is additionally bound to the person who clicked. (The reference used a public API callback
authenticated by the `state` alone.)

**Expiry and refresh**: the Toolbox issues no refresh token (`grant_types_supported: ["authorization_code"]`); at
expiry (minus one minute) or on a 401 the token is marked invalidated → *À reconnecter*. A standard `refresh_token`
grant is used only when a server offers one (tested with the fake), never assumed.

**Oublier la connexion…** → confirmation (*Retour* focused) → `POST /api/settings/toolbox/forget`: the token, who
connected and the last error are deleted from the file (the client registration stays); audit `toolbox.forgotten`.
The Toolbox has no revocation endpoint: the deleted token expires by itself at its end date.

## Token storage (`app/services/toolbox/token_store.py`)

- A JSON file, **never the database** (the database is copied by backups and readable by the Database Explorer and
  the SQL console): `VIPER_TOOLBOX_TOKEN_STORE_PATH`, default `~/.viper/toolbox-oauth.json`; a path **inside the
  repository checkout is refused at startup**.
- Directory created `0700`, file `0600`, written atomically (temporary file in the same directory + `os.replace`). On
  Windows the modes are ignored: the file inherits the ACL of the user profile — keep it under the service account's
  profile.
- Unreadable or malformed file = not connected (logged as a warning, never a crash).
- Tokens are excluded from `repr`, never logged, never returned by an API (no route accepts or returns one), never
  sent to the browser.

## API — `/api/settings/toolbox` (session + CSRF, `api_router`; registered before `/settings/{taxonomy}`)

| Method & path | Body | Answer |
|---|---|---|
| `GET /settings/toolbox` | — | `ToolboxStatus` |
| `POST /settings/toolbox/connect` | — | `{authorization_url}` |
| `POST /settings/toolbox/callback` | `{state, code, iss, error}` (strings; unknown fields ignored) | `ToolboxStatus` |
| `POST /settings/toolbox/forget` | — | `ToolboxStatus` |

```json
{
  "enabled": true, "state": "connected", "configured": true, "connected": true, "missing": [],
  "toolbox_origin": "https://toolbox.example", "connected_at": "…", "connected_by": "Prénom Nom",
  "expires_at": "…", "account_label": null, "last_error": {"code": "toolbox_access_denied", "at": "…"},
  "cleanups": {"pending": 2, "failing": 1}
}
```

`account_label` is always null: the Toolbox's answers name no mailbox. `missing` holds variable names, never values.

Refusals (`{detail: {code, message}}`): 503 `toolbox_not_configured`; 502 `toolbox_unavailable` / 504
`toolbox_timeout` (discovery, registration or token exchange); 422 `toolbox_rejected` (PKCE S256 missing, registration
refused); 400 `toolbox_state_invalid`, 403 `toolbox_access_denied`, 400 `toolbox_authorization_failed`, 400
`toolbox_issuer_mismatch`, 502 `toolbox_token_exchange_failed`, 422 `toolbox_scope_missing`. Every failure of
*connect* and *callback* is recorded as `last_error` (code + time) and logged with its code
(`toolbox.connect_failed code=…`); success is logged too (`toolbox.connected`). The browser gives up after 90 s.

## Front end

`frontend/src/settings/ConnectionsSection.tsx` (the card, the OAuth return, the confirmation), copy in
`settings/toolboxCopy.ts` (states, `toolbox_*` reasons, limitations — shared with the Contact editor),
`api/toolbox.ts` (queries/mutations). Same `.settings-tabs` / `.settings-panel` pattern as the other sections; the
card is `.settings-connection` (canvas background inside the surface panel, accent-soft icon tile, `StatusBadge`,
uppercase muted fact labels, danger-soft last error) — `settings.css`.

## Connecting for real (operator)

1. Ask the Toolbox owner which MCP URL to use (handoff docs/07: `https://circoetoolbox-server-production.up.railway.app/mcp`)
   and make sure the Toolbox accepts VIPER's redirect URI (HTTPS, or `http://localhost` in development).
2. On the server: `VIPER_TOOLBOX_MAIL_ENABLED=true`, `VIPER_TOOLBOX_MCP_URL=…`,
   `VIPER_TOOLBOX_OAUTH_REDIRECT_URI=https://<viper host>/settings/connections` (development:
   `http://localhost:5173/settings/connections`), optionally `VIPER_TOOLBOX_TOKEN_STORE_PATH`; restart the API.
3. Paramètres › Connexions › *Connecter la Toolbox*; sign in at Infomaniak and paste a personal API token with the
   Mail scope **of the mailbox that must send** (the sender is that account's default mailbox).
4. Validate a test message to an internal address and check the draft in Infomaniak's Drafts folder; cancel it and
   check it disappears (within `VIPER_TOOLBOX_CLEANUP_INTERVAL_MS`).
5. Reconnect every 30 days (the tab says *À reconnecter*).
