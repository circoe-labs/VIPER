# Suites de la Slice 09 (2026-11-04)

- **Organisation des jetons.** `mcp_tokens.mint` / `create_for` et `mcp_calls.record` ne renseignent pas
  `organization_id` : tout jeton et tout appel tombent par défaut dans CIRCOE, y compris un jeton créé depuis
  Paramètres par un membre d'une autre organisation. La gestion (Slice 09) suit l'organisation du propriétaire,
  mais `/mcp` exécute le jeton dans CIRCOE (`grant_for` lit `record.organization_id`). Un jeton dont le
  propriétaire a été supprimé retombe dans CIRCOE et devient gérable par l'admin CIRCOE.
- **Coût de la liste.** `visible_agents` charge tous les jetons et appelle `delegate_of` sur chacun (1 à 3 requêtes
  par jeton). Sans effet aujourd'hui ; à filtrer en SQL si la liste grossit.
- **Adresse réattribuée.** Si une autre personne reprend l'adresse d'un propriétaire supprimé, elle devient
  propriétaire de ses jetons CLI (comportement antérieur de `delegate_of`).
