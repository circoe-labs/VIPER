# Slice 01 — suites liées aux autorisations (QA du 2026-11-03)

- **Antérieur à la tâche, sécurité :** `POST /api/settings/mcp/agents/{id}/revoke` (`routes/mcp_settings.py:185`)
  ne vérifie ni le rôle ni le propriétaire. N'importe quel membre connecté peut révoquer le jeton de n'importe qui,
  y compris celui d'un admin. À corriger rapidement.
- **Organisations :** `create_for` et `oauth.approve` ne renseignent pas `organization_id`, donc tout retombe sur
  CIRCOE. `grant_for` ne vérifie pas non plus que l'organisation de l'utilisateur délégué est celle du jeton. Le
  risque est latent tant que seule CIRCOE peut se connecter ; il faut le corriger avant d'ouvrir à d'autres
  organisations.
- `tools/list` n'est pas filtré par capacité.
