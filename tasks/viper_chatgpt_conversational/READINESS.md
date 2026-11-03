# Slice 00 — Readiness

État : **READY** (2026-11-03). Le premier audit concluait HUMAN_DECISION_REQUIRED ; les trois décisions humaines ont été prises depuis.

## Constat de l'audit

Le handoff ignorait la PR #12, qui livrait déjà :

- OAuth 2.1 (`services/oauth.py`, migration 0022) : chaque connexion ChatGPT ou claude.ai est rattachée à un
  `McpToken` stable et à un `user_id`. L'identité reste donc la même quand les jetons OAuth sont renouvelés.
- Les organisations et les rôles `admin` / `manager` / `member` (`models/organizations.py`, migration 0023).
  `McpToken` appartient à une organisation (`OrganizationOwnedMixin`).
- `missions.update` (PUT) : réécrit toute la règle sans toucher aux runs passés ni à leurs tâches, et refuse une
  mission clôturée. `missions.delete` et `missions.pending_proposals()` existent aussi.
- Le journal des appels MCP (`McpCall`, migration 0024, `services/mcp_calls.py`).

Ce qui manque : les outils MCP conversationnels (§8), les annotations d'outils MCP, les valeurs `facility_*` dans
`SignalKind`, ainsi que les établissements et le déclencheur dans `CompanyProposal`. `SignalProposal` existe déjà
pour `surveil_signals`.

## Décisions humaines (2026-11-03)

1. **Base de travail** : la PR #12 a été fusionnée dans `main` après le commit du journal MCP. La connexion
   Infomaniak reste désactivée (`VIPER_INFOMANIAK_LOGIN_ENABLED=false` par défaut) tant que le callback n'est pas
   configuré. Le travail se fait sur `feat/chatgpt-conversational`.
2. **Identité** : pas de table `AgentPrincipal`. On étend `McpToken` avec `provider`, `mode` et `capabilities`.
   Les jetons OAuth servent de credentials renouvelables. Un jeton bearer manuel change d'identité s'il est
   régénéré : la limite est acceptée, voir `Issues/bearer-token-rotation.md`.
3. **Capacités effectives** = capacités du rôle de l'utilisateur délégué ∩ capacités de l'agent.
   - `member` peut lire, créer et lancer une mission, la mettre en pause et la reprendre.
   - `manager` et au-dessus peuvent en plus annuler et supprimer une mission.
   - Un agent sans utilisateur délégué (worker, planifié) n'a que ses propres capacités.

## Décisions ouvertes tranchées par le PM (réversibles)

- n°4, modifier une mission pendant un run : autorisé ; la modification s'applique aux runs suivants. C'est le
  comportement actuel de `update`.
- n°5, signaux liés aux sites : de vraies valeurs d'enum (`facility_opening`, `facility_expansion`,
  `construction`, `relocation`).
- n°6, accepter un résultat `find_prospects` : l'entreprise, ses établissements et le signal sont créés dans une
  seule transaction relue.
- n°7 et n°8, accepter ou rejeter un résultat, valider ou envoyer un mail depuis ChatGPT : hors périmètre de cette
  livraison.
- n°10, ressources de l'UI : à décider dans la Slice 06.

## Amendements au plan

- La Slice 01 est réduite : pas de nouvelle table séparant principal et credential.
- La Slice 03 est réduite : les services existent déjà ; il reste l'exposition MCP, les capacités et les
  annotations.
- La Slice 04 réutilise `SignalProposal` comme forme du déclencheur.

## Tiers QA

01, 03, 04 et 07 : critical. 02 : glue. 05 : docs. 06 : ui. 08 : release.
