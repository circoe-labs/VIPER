# Slice 01 — Capacités d'agent et `viper_whoami`

Tier QA : **critical** (authentification, migration). Références : HANDOFF §5 et §6, READINESS (décisions 2 et 3).

## But

Chaque appel MCP est rattaché, côté serveur, à une identité stable et à un ensemble de capacités effectives.
Toute mutation MCP passe par une garde unique.

## Périmètre

- **Migration** : `mcp_tokens` reçoit trois colonnes :
  - `provider` : `chatgpt|claude|chatx|other` ;
  - `mode` : `interactive|worker|scheduled` ;
  - `capabilities` : JSONB, vocabulaire fonctionnel.

  Rétrocompatibilité : les jetons existants passent en `mode=worker` avec les capacités d'un worker. Les jetons
  créés par OAuth (`services/oauth.py`) passent en `mode=interactive`, avec un `provider` déduit du client OAuth
  quand c'est possible.
- **Vocabulaire**, défini dans `services/mcp_tokens.py` ou dans un module dédié :
  - `tasks.work` : claim, heartbeat, submit, fail, release, queue ;
  - `records.read`, `records.propose`, `dashboard.read` ;
  - `missions.read`, `missions.write` (créer, modifier), `missions.run`, `missions.pause`,
    `missions.cancel` (annuler, supprimer) ;
  - `reviews.read`, `contact.read`, `contact.draft`.

  Les `scopes` actuels (types de tâches) restent un filtre de tâches, distinct des capacités.
- **Calcul des capacités effectives** : capacités de l'agent ∩ capacités du rôle de l'utilisateur délégué. Le
  rôle s'obtient via `OAuthAuthorization.user_id`, puis le rôle de cet utilisateur dans l'organisation. `member`
  n'a pas `missions.cancel`. Sans utilisateur délégué, seules les capacités de l'agent comptent.
- **Garde** : une seule fonction `require(capability)` dans `api/mcp.py`. Un refus renvoie une erreur MCP
  explicite, et `McpCall` l'enregistre avec un `outcome` de refus.
- **Outils existants** : chacun est rattaché à sa capacité. Le comportement des workers ne change pas.
- **`viper_whoami`** renvoie : l'id du jeton, son libellé, `provider`, `mode`, l'utilisateur délégué (e-mail et
  rôle), l'organisation, les capacités effectives et la version.
- **Audit** : un agent qui agit pour un utilisateur garde `ActorContext.type=AGENT` et porte l'utilisateur
  délégué, affiché « ChatGPT X pour Y ». S'appuyer sur le `services/audit.py` existant.
- **Réglages MCP** (`routes/mcp_settings.py`, `McpSection.tsx`) : afficher le mode et les capacités, et permettre
  de les choisir à la création d'un jeton.

## Hors périmètre

Une nouvelle table d'agents. Le renouvellement du secret d'un jeton bearer (voir Issue).

## Validation

Tests ciblés :
- migration aller et retour ;
- calcul de l'intersection ;
- refus de `missions.write` pour un worker ;
- `whoami` pour un jeton bearer et pour un jeton OAuth.

Plus une revue de code.
