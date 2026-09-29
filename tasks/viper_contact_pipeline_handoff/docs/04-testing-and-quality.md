# 04 — Tests et qualité

## Principes

Chaque règle métier verrouillée doit exister dans un test, pas seulement dans du JSX ou un commentaire.

Les tâches de code doivent charger `/caveman` et `/coding-guideline` avant implémentation.

## Gates obligatoires

À la fin de chaque tâche de code pertinente :

```bash
npm test
npm run typecheck
npm run lint
npm run build
```

Si le dépôt ou l’environnement ne permet pas une commande, le rapport doit l’indiquer explicitement avec la raison.

## Tests de domaine à exiger

### États prospects

- nouveau prospect = `neutral` interne et aucun badge visible ;
- `neutral + week` affiche seulement la semaine ;
- `contacted + week` affiche Contacté + semaine ;
- `r1 + week` affiche R1 + semaine ;
- `r2 + week` affiche R2 + semaine ;
- `response_received`, `appointment_obtained`, `failure`, `ignored` sont sélectionnables manuellement ;
- aucune transition n’a lieu automatiquement à partir d’un email envoyé ou d’un timestamp ;
- `ignored` force le blocage durable et résiste au réimport.

### Cadence

- Contact S40 propose R1 S42 ;
- R1 S42 propose R2 S44 ;
- R2 S44 propose revue S48 ;
- aucune de ces propositions ne force automatiquement un changement d’état.

### Messages

- génération IA => `draft` ;
- `draft` ne peut pas être envoyé ;
- validation manuelle requise ;
- modification d’un `validated` ou `scheduled` => retour `draft` ;
- `sent` non modifiable ;
- `scheduled` seulement avec `scheduled_at` valide ;
- changement manuel vers `response_received`, `appointment_obtained` ou `ignored` => messages futurs annulés ;
- messages déjà `sent` restent inchangés.

### Dispatcher

- message non validé jamais envoyé ;
- message futur jamais envoyé trop tôt ;
- deux scans concurrents ne doivent pas produire deux envois ;
- redémarrage ne doit pas réenvoyer un message déjà confirmé ;
- erreur Toolbox doit laisser une trace diagnostic sans marquer à tort le message `sent`.

### IA

- clé API absente => erreur explicite et aucun changement de données ;
- données manquantes => génération avec contexte disponible uniquement ;
- le prompt interdit l’invention de faits ;
- la sortie est validée côté serveur avant persistance ;
- régénération ne valide pas automatiquement le message.

## Tests de migration

Créer un fixture synthétique couvrant les anciens statuts :

- `to_contact`
- `contacted`
- `follow_up_1`
- `follow_up_2`
- `response_received`
- `appointment_obtained`
- `quote_sent`
- `quote_follow_up`
- `won`
- `not_interested`

La migration doit produire un rapport clair et préserver l’historique. Aucun enregistrement ne doit être silencieusement perdu.

## Qualité UX

- pas plus de badges que nécessaire ;
- état et semaine toujours distinguables ;
- cards cliquables utilisables au clavier ;
- page Contact utilisable sans scroll horizontal global ;
- panneau gauche reste lisible pendant l’édition du mail ;
- états d’email visibles sans jargon technique ;
- confirmation claire avant validation/programming.
