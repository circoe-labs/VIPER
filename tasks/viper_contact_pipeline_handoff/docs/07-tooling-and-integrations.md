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

### Envoi programmé — modèle d’exécution et reprise (Task 16, `src/server/contactMessageDispatcher.ts`)

- **Exécution** : scan périodique dans le process serveur (`CONTACT_DISPATCH_INTERVAL_MS`, 30 s ; démarré seulement si la Toolbox est activée et configurée ; une passe ne fait rien tant qu’elle n’est pas connectée) ; jamais deux passes en parallèle dans un process ; arrêt propre sur SIGINT/SIGTERM (l’envoi en cours se termine, 30 s max).
- **Verrou** : avant tout appel réseau, UPDATE conditionnel dans une transaction IMMEDIATE (`scheduled`, dû, non verrouillé, même révision, validation courante, même brouillon distant, même nombre de tentatives) + revérification de l’état prospect dans la même transaction (séquence fermée ⇒ annulation) ; `dispatch_attempts+1`, événement `dispatch_claimed`. Deux passes ou deux process : un seul gagne. `send_draft` suit immédiatement.
- **Succès** : `markSent` (un seul UPDATE, `sent` immuable). Aucun changement d’état prospect.
- **Échec certain** (refus avant exécution) : transitoire (injoignable/429, délai à l’initialisation, auth, non configurée) ⇒ verrou relâché, `last_error_code`, nouvel essai après backoff (60 s × 2^n, 1 h max), au plus `CONTACT_DISPATCH_MAX_ATTEMPTS` ; définitif (allowlist, refus, champ invalide, brouillon introuvable) ou tentatives épuisées ⇒ retour `validated` (date effacée, validation conservée) pour reprogrammation humaine. Toujours `send_failed`, jamais `sent`.
- **Issue inconnue** (timeout/coupure/5xx pendant `send_draft`, réponse illisible, erreur interne) : verrou **conservé**, `send_outcome_unknown`, aucun renvoi.
- **Réconciliation** (verrou plus vieux que `CONTACT_DISPATCH_CLAIM_TTL_MS`, 10 min, > 2 × délai Toolbox, non tenu par ce process — issue inconnue, process tué, `markSent` impossible après envoi) via `list_drafts` (100) : brouillon absent d’une liste non pleine ⇒ `sent` (`send_reconciled_draft_absent`, envoi déduit) ; brouillon présent ⇒ retour `validated` + `send_not_confirmed` (un humain vérifie puis reprogramme) ; liste pleine ou illisible ⇒ rien, nouvel essai à la passe suivante. Un verrou n’est jamais relâché vers un renvoi automatique.
- **Retard** (serveur éteint, Toolbox déconnectée) : envoi tardif accepté jusqu’à `CONTACT_DISPATCH_MAX_LATENESS_MS` (6 h) après `scheduled_at` ; au-delà, pas d’envoi : retour `validated` + `dispatch_overdue`.
- **Annulation pendant un envoi** (décision 29) : un message verrouillé n’est pas annulable (`inFlight`, signalé à l’utilisateur) ; si l’envoi échoue, le dispatcher l’annule aussitôt ; s’il a réussi, il reste `sent`.
- Une nouvelle programmation efface le diagnostic (`dispatch_attempts=0`, `last_error_code`). Journal/audit : identifiants, codes, statuts seulement.

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
