# Slice 07 — suites (QA du 2026-11-03)

- **Appel IA dans la transaction MCP.** Chaque génération garde une connexion à la base ouverte (« idle in
  transaction ») jusqu'à 60 s, plus les nouvelles tentatives. Dans un batch JSON-RPC, une mise à jour suivie d'une
  génération garde aussi le verrou de la ligne du premier message pendant tout l'appel IA. Piste : commiter avant
  l'appel IA, comme le fait la route REST.
- **Historique des appels MCP.** `mcp_calls.shorten` conserve les 300 premiers caractères du sujet et du corps, et
  jusqu'à 50 destinataires, pour chaque appel de mise à jour. Il faut décider de la rétention ou du masquage de ces
  données.
- `expected_revision: true` est accepté comme la révision 1 (mode lax de Pydantic, même comportement côté REST).
  C'est sans conséquence.
