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

## Contrat des outils brouillons (vérifié dans le code le 29/09/2026, commit `60ad176`, Task 15)

- `infomaniak.mail.create_draft` : `{ to: email[1..50], cc?: email[≤50], bcc?: email[≤50], subject: 1..500, text: 1..200000, html?, inReplyTo?: { uid, folder } }` → `{ draftId, draftUid, to, cc, bcc, subject, inReplyTo, hint }`. Pas de `from` : expéditeur = boîte par défaut du token API Infomaniak de la connexion. L'allowlist s'applique.
- `infomaniak.mail.send_draft` : `{ draftId }` → `{ sent: true, pendingConfirmation: false, draftId, to, cc, bcc, subject, reason, provider: { transport, etop, cancelResource } }`. Pas d'identifiant de message envoyé. Seule l'allowlist s'applique (l'approbation humaine remplace la politique d'envoi direct). Brouillon absent : « Brouillon introuvable ».
- `infomaniak.mail.delete_draft` : `{ draftId }` → `{ deleted: true, draftId }` ; brouillon absent : erreur « L'API Infomaniak Mail a répondu 404 ».
- `infomaniak.mail.list_drafts` : `{ limit: 1..100 (20) }` → `{ folder, drafts: [{ draftId, subject, to, cc, date, preview }] }`.
- Erreurs : `result.isError` + texte français ; les codes internes (`TOOLBOX_OUTBOUND_BLOCKED`, `INFOMANIAK_MAIL_HTTP_404`…) ne sont pas transmis par MCP.
- Transport : Streamable HTTP sans état, réponses JSON ; outils listés et appelables seulement si le jeton porte leur scope.
