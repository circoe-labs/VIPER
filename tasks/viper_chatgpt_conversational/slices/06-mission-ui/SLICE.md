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

## Notes d'implémentation (Slice 06)

### Version de l'Apps SDK vérifiée (2026-11-03)

Sources : <https://developers.openai.com/plugins/build/chatgpt-ui>, <https://developers.openai.com/apps-sdk/reference>,
<https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx>. Les pages
d'OpenAI ne portent ni date ni numéro de version ; la spécification MCP Apps est la version `2026-01-26`.

La documentation actuelle **contredit la Slice** sur un point, et c'est elle qui est suivie :
`text/html+skybridge` n'est plus mentionné. Le type MIME est `text/html;profile=mcp-app` (extension MCP Apps),
et le lien standard est `_meta.ui.resourceUri`, `openai/outputTemplate` restant un alias lu par ChatGPT.

Clés utilisées :

- ressource : `mimeType: text/html;profile=mcp-app`, `_meta.ui.prefersBorder`, `_meta.ui.csp`
  (`connectDomains`, `resourceDomains` vides), `openai/widgetPrefersBorder`, `openai/widgetDescription` ;
- outil `viper_create_mission` : `_meta.ui.resourceUri`, `openai/outputTemplate`, `openai/widgetAccessible`,
  `openai/toolInvocation/invoking` et `invoked` (64 caractères au plus) ; le même lien dans le `_meta` de chaque
  résultat, refus compris ;
- outils appelés par la carte (`viper_mission_options`, `viper_update_mission`, `viper_run_mission`) :
  `openai/widgetAccessible: true` ; `ui.visibility` reste à sa valeur par défaut (`model` et `app`) ;
- côté carte : `window.openai` (`toolInput`, `toolOutput`, `toolResponseMetadata`, `theme`, `widgetState`,
  `setWidgetState`, `callTool`, évènement `openai:set_globals`), et sinon le pont `postMessage` de MCP Apps
  (`ui/initialize`, `ui/notifications/initialized`, `tool-input`, `tool-result`, `host-context-changed`,
  `size-changed`, `tools/call`).

### Décision n°10 (ressources de l'UI)

Un seul gabarit HTML autonome (`backend/app/api/mcp_ui/mission_card.html`, CSS et JS en ligne, aucune
dépendance), lu sur disque et servi par `resources/read`. Le catalogue et les métadonnées vivent dans
`backend/app/api/mcp_ui.py`. L'URI porte une version (`ui://viper/mission-card-v1.html`), car les hôtes mettent
les gabarits en cache. Le fichier est livré par `COPY backend/app` (`deploy/Dockerfile.api`). Le frontend React
n'est pas touché.

### Écart assumé

Le gabarit est attaché à `viper_create_mission`, comme demandé : la mission existe donc déjà quand la carte
s'affiche (création additive, HANDOFF §14.4). La carte montre alors « Lancer maintenant » et « Modifier les
paramètres ». « Créer » et « Créer et lancer » servent quand la création a été refusée : le formulaire est
prérempli et l'erreur du serveur est affichée telle quelle. Un aperçu *avant* création demanderait un outil de
rendu en lecture seule. Il n'est pas construit (question ouverte n°6 de `mcp-server.md`).

### À vérifier dans le vrai ChatGPT

- La carte s'affiche bien pour un résultat `isError: true` et `toolOutput` contient bien le refus.
- `callTool` répond bien avec la forme `CallToolResult` (`structuredContent`, `isError`) attendue par la carte.
- Le thème transmis, la hauteur automatique et le `widgetState` survivent à un rechargement de la conversation.
- Faut-il `ui.domain` / `openai/widgetDomain` pour un connecteur non publié ? Non renseigné pour l'instant.
