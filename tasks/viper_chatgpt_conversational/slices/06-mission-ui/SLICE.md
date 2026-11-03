# Slice 06 — UI de création de mission (app MCP)

Tier QA : **ui**. Dépend du contrat de la Slice 03. Références : HANDOFF §14, décision ouverte n°10.

- **Composant** : optionnel, servi comme ressource MCP (Apps SDK, `text/html+skybridge`) et associé à
  `viper_create_mission` par la métadonnée de template de sortie. Les outils restent utilisables sans lui.
- **Contenu** : une carte récapitulative préremplie, avec des champs modifiables et les boutons « Créer »,
  « Créer et lancer » et « Modifier ». Les erreurs de validation du serveur s'affichent telles quelles.
- **Autorisations** : aucune logique d'autorisation dans l'UI.
- **Avant de commencer** : vérifier la version actuelle de l'Apps SDK d'OpenAI et la consigner dans la Slice.

## Contexte de dispatch (mis à jour par le PM après la fusion de la Slice 03)

- Contrat des outils : `backend/app/api/mcp_missions.py`. `viper_create_mission` (schéma `MissionIn`, `run_now`),
  `viper_update_mission` (mise à jour partielle, schéma sans `default`) et `viper_mission_options` (valeurs
  possibles des listes). Documentation : `doc/architecture/mcp-server.md` §3.10.
- Le serveur MCP est `backend/app/api/mcp.py` (JSON-RPC, `tools/list`, `tools/call`). Il n'expose aucune
  ressource pour l'instant : la Slice ajoute `resources/list` / `resources/read` pour le template, et
  `_meta["openai/outputTemplate"]` (ou son équivalent dans la version actuelle de l'Apps SDK) sur
  `viper_create_mission`.
- Le composant est un bundle HTML et JS autonome, servi par le backend. Il ne fait pas partie de l'application
  React principale, et le build du frontend doit continuer de passer.
- Migration : aucune.
