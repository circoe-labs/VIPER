# 07 — Tooling et intégrations

## CIRCOE Toolbox

Dépôt : `circoe-labs/circoe-toolbox`

Endpoint communiqué :

```text
https://circoetoolbox-server-production.up.railway.app/mcp
```

Le README audité le 29/09/2026 expose les outils mail suivants :

```text
infomaniak.mail.search
infomaniak.mail.get_thread
infomaniak.mail.read
infomaniak.mail.create_draft
infomaniak.mail.create_drafts
infomaniak.mail.send_draft
infomaniak.mail.list_drafts
infomaniak.mail.delete_draft
infomaniak.mail.reply
infomaniak.mail.send
```

Le MCP Toolbox utilise OAuth 2.1 Authorization Code + PKCE et délègue ensuite l’authentification à Infomaniak. L’intégration VIPER doit donc résoudre explicitement l’identité/utilisateur autorisé plutôt que d’ajouter un secret opaque non documenté.

### Usage recommandé par VIPER

- message local `draft` : seulement dans la base VIPER ;
- validation humaine : créer un brouillon distant via `create_draft`, puis stocker `remote_draft_id` ;
- modification après validation : invalider localement et supprimer le remote draft si présent ;
- programmation : garder `scheduled_at` dans VIPER ;
- échéance atteinte : appeler `send_draft` ;
- annulation : supprimer le remote draft si non envoyé, puis marquer localement `cancelled`.

Ce design évite de polluer Infomaniak avec chaque génération IA non validée.

## OpenAI

### Règles

- appel serveur uniquement ;
- clé via variable d’environnement ;
- modèle via variable d’environnement, car l’identifiant exact n’a pas été verrouillé pendant le grill ;
- jamais de clé dans le bundle client ;
- timeout, retries bornés, erreurs typées ;
- sortie validée avant persistance ;
- pas d’appel OpenAI pour changer un statut.

### Entrées minimales de génération

Envoyer seulement les données disponibles et utiles :

- identité du prospect ;
- rôle/fonction ;
- entreprise ;
- contexte entreprise existant dans VIPER ;
- email étape précédente pour R1/R2 ;
- instructions éditoriales ;
- éventuel lien de prise de rendez-vous configuré.

Le prompt doit interdire explicitement l’invention d’un signal, d’une actualité ou d’une référence non présente dans les données fournies.

### Sortie recommandée

Objet structuré :

```json
{
  "subject": "...",
  "body": "..."
}
```

Valider cette forme côté serveur.

## Adresse From

L’utilisateur a cité oralement une adresse de Lucie comme valeur par défaut, mais la transcription est incertaine. **Ne pas la hardcoder.** Utiliser une configuration serveur ou Settings, par exemple `DEFAULT_OUTBOUND_EMAIL`, puis préremplir l’éditeur depuis cette valeur.
