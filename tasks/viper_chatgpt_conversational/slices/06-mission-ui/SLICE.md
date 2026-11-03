# Slice 06 — UI de création de mission (app MCP)

Tier QA : **ui**. Dépend du contrat de la Slice 03. Références : HANDOFF §14, décision ouverte n°10.

- **Composant** : optionnel, servi comme ressource MCP (Apps SDK, `text/html+skybridge`) et associé à
  `viper_create_mission` par la métadonnée de template de sortie. Les outils restent utilisables sans lui.
- **Contenu** : une carte récapitulative préremplie, avec des champs modifiables et les boutons « Créer »,
  « Créer et lancer » et « Modifier ». Les erreurs de validation du serveur s'affichent telles quelles.
- **Autorisations** : aucune logique d'autorisation dans l'UI.
- **Avant de commencer** : vérifier la version actuelle de l'Apps SDK d'OpenAI et la consigner dans la Slice.
