# Slice 09 — Qui peut révoquer un accès MCP

Tier QA : **critical** (autorisation). Créée par le PM le 2026-11-04 sur décision de l'utilisateur. Faille
antérieure à la tâche, relevée pendant la Slice 08.

## Problème

`POST /api/settings/mcp/agents/{agent_id}/revoke` (`backend/app/api/routes/mcp_settings.py`) ne vérifie ni le
rôle ni le propriétaire : n'importe quel membre connecté peut révoquer le jeton de n'importe qui, y compris celui
d'un admin ou un connecteur ChatGPT d'une autre personne.

## Règle

Peut révoquer un accès :
- la personne pour qui il agit (son propriétaire : `owner_email` du jeton, ou la personne qui a approuvé
  l'autorisation OAuth — réutiliser la résolution existante de `delegate_of` dans
  `app/services/agent_capabilities.py` ou `mcp_tokens`, ne pas la réécrire) ;
- un `admin` de la même organisation, ou un superadmin (`user.is_superadmin`) ;
- un jeton sans propriétaire : admin ou superadmin seulement.

Sinon : **404** (même réponse qu'un id inconnu, pour ne pas révéler l'existence du jeton) ou 403 — choisir,
justifier dans la doc, et garder un code d'erreur stable. Le contrôle va dans un service, pas en ligne dans la
route. Modèle de vérification de rôle existant : `backend/app/api/routes/database_reset.py:30` et
`app/services/organizations.py`.

## À vérifier dans la même passe

- `GET /api/settings/mcp/agents` et `GET /api/settings/mcp/calls` : un `member` voit-il les jetons et
  l'historique des autres ? Si oui, appliquer la même règle (un member ne voit que les siens ; admin et superadmin
  voient tout dans leur organisation). Si le frontend dépend de la liste complète, l'adapter pour qu'il reste
  cohérent (bouton « Révoquer » masqué quand l'action serait refusée — l'autorisation reste côté serveur).
- La création de jeton (`POST /mcp/agents`) est déjà bornée par le rôle : ne pas la changer.

## Validation

Tests : member révoque le sien (ok), member révoque celui d'un autre / d'un admin / un OAuth d'un autre (refusé,
jeton toujours valide sur `/mcp`), admin révoque celui d'un member de son organisation (ok), admin d'une autre
organisation (refusé), superadmin (ok), jeton sans propriétaire. Vitest si le frontend change ; `tsc` et build
propres. Documentation : `doc/architecture/mcp-server.md` (§4.7 ou la section sur la gestion des accès).

## Contexte de dispatch

- Branche de base : `feat/chatgpt-conversational`. Migration : aucune.
- Base de test dédiée : `VIPER_TEST_DATABASE_URL=postgresql+psycopg://viper:viper@127.0.0.1:5442/viper_s09_test`.
- Ne pas toucher `app/services/missions.py` ni `app/services/agent_missions.py` (Slice 03.1 en parallèle).
