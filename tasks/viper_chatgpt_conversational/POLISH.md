# Polish en attente

Ces points sont regroupés ici et seront traités par le prochain implémenteur concerné ou en Slice 08, sans nouvelle
boucle de vérification.

## Slice 04

- Tester le refus d'une URL non http(s) pour la source du déclencheur et pour celle d'un site, ainsi que le refus
  `too_old`. Ces trois contrôles n'ont aucun test : les mutations M6, M8 et M10 ont survécu.
- Passer `SCHEMA_VERSION` à 2 (`agent_payloads.py:48`), car la forme de sortie a changé
  (`agent-missions.md:391`).
- `ReviewDialog.tsx:76` : ajouter `role="group"` (ou utiliser une `section`) pour que l'`aria-label="Déclencheur"`
  soit annoncé.

## Slice 02

- `viper_get_contact_overview` renvoie les listes complètes de la planification, qui peuvent être longues pour
  ChatGPT. À limiter ou paginer si les traces de la Slice 08 le montrent.

## Slice 01

- Pré-filtrer les capacités proposées selon le rôle dans `McpAgentCreate.tsx`. Aujourd'hui, un `member` qui choisit
  le mode « Assistant » reçoit un 403 tant qu'il n'a pas décoché `missions.cancel`.

## Régressions à corriger en Slice 08 (bloquantes pour la release)

- `tests/test_agents_api.py::test_the_settings_page_lists_the_mcp_tools` attend `viper_claim_task` en premier.
  Depuis la Slice 01, `viper_whoami` est en tête de liste.

## Slice 03

- `mcp_settings._type_of` ne lit pas `anyOf`, si bien que les champs nullables s'affichent comme « objet » dans
  Paramètres › MCP.
