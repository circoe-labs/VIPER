# CIRCOE Toolbox — capacités vérifiées le 29/09/2026

Source auditée : README du dépôt `circoe-labs/circoe-toolbox`.

## Mail

- `infomaniak.mail.search`
- `infomaniak.mail.get_thread`
- `infomaniak.mail.read`
- `infomaniak.mail.create_draft`
- `infomaniak.mail.create_drafts`
- `infomaniak.mail.send_draft`
- `infomaniak.mail.list_drafts`
- `infomaniak.mail.delete_draft`
- `infomaniak.mail.reply`
- `infomaniak.mail.send`

## Authentification MCP

OAuth 2.1 Authorization Code + PKCE, puis authentification Infomaniak et token API personnel vérifié côté Toolbox.

## Politique outbound

La Toolbox possède une politique serveur avant tout envoi. En configuration `INFOMANIAK_DIRECT_SEND_MAIL=none`, `mail.send` / `mail.reply` créent un brouillon et `mail.send_draft` est appelé après approbation explicite.

## Scheduling

Aucun outil de scheduling mail n’a été identifié dans le README audité. La session produit décide que VIPER porte donc `scheduled_at` et le déclenchement.
