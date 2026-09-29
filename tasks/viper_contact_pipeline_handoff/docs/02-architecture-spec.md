# 02 — Spécification d’architecture cible

## 1. Frontières

### Prospection

Responsable de :

- qualité et lecture des données prospects ;
- sélection humaine d’une prochaine semaine de contact ;
- visibilité des badges d’état et de prochaine semaine ;
- édition de la fiche prospect.

Prospection ne devient pas un éditeur d’email.

### Contact

Responsable de :

- priorisation par semaine ;
- filtrage par état / semaine ;
- préparation et consultation de la séquence Contact/R1/R2 ;
- génération IA de brouillons ;
- validation humaine ;
- programmation date/heure ;
- déclenchement différé de l’envoi ;
- sélection manuelle du statut prospect.

### CIRCOE Toolbox

Responsable de :

- interaction technique avec Infomaniak ;
- création/suppression/envoi de brouillons ;
- politiques d’envoi sortant et authentification MCP.

La Toolbox ne porte pas la logique de campagne VIPER.

### OpenAI

Responsable uniquement de produire une proposition textuelle. Le modèle ne reçoit jamais l’autorité pour modifier un statut ou envoyer un message.

## 2. Contrat d’état prospect

Enum interne recommandé :

```text
neutral
contacted
r1
r2
response_received
appointment_obtained
failure
ignored
```

Labels UI :

```text
neutral              -> aucun badge
contacted            -> Contacté
r1                   -> R1
r2                   -> R2
response_received    -> Réponse reçue
appointment_obtained -> RDV pris
failure              -> Failure
ignored              -> Ignoré
```

Le code ne doit pas déduire ou changer l’état à partir d’un email envoyé/reçu. Toute transition doit provenir d’une action humaine explicite.

## 3. Prochaine échéance

La prochaine échéance doit être représentée par année ISO + semaine ISO afin d’éviter l’ambiguïté aux changements d’année.

Recommandation :

```text
next_action_year INTEGER NULL
next_action_week INTEGER NULL
```

Le badge UI peut afficher uniquement `S40`, mais les filtres backend doivent utiliser le couple `(year, week)`.

Sémantique :

- `neutral + S40` : premier contact à préparer/faire en S40 ;
- `contacted + S42` : R1 à préparer/faire en S42 ;
- `r1 + S44` : R2 à préparer/faire en S44 ;
- `r2 + S48` : revue humaine à effectuer en S48 ;
- états `response_received`, `appointment_obtained`, `failure`, `ignored` : pas d’échéance active par défaut.

## 4. Contrat de message

Enum étape :

```text
contact
r1
r2
```

Enum état message :

```text
draft
validated
scheduled
sent
cancelled
```

Transitions autorisées :

```text
draft -> validated
validated -> scheduled
scheduled -> sent
validated -> draft      (édition)
scheduled -> draft      (édition)
draft|validated|scheduled -> cancelled
```

`sent` est immuable fonctionnellement.

Une implémentation peut fusionner `validated` et `scheduled` lorsque `scheduled_at` est présent, mais le contrat UI doit préserver la distinction conceptuelle.

## 5. Couche domaine

Créer des services explicites au lieu d’ajouter la logique dans `src/server/index.ts` :

- `contactWorkflow` : enums, labels, cadence, validation des transitions ;
- `contactTrackingService` : mutations humaines d’état / semaine ;
- `contactMessageService` : CRUD + validation de messages ;
- `messageGenerationService` : appel OpenAI ;
- `mailToolboxAdapter` : appels MCP mail ;
- `scheduledMailDispatcher` : recherche des messages dus et envoi idempotent.

Noms exacts adaptables au style du dépôt, mais les responsabilités doivent rester séparées.

## 6. Effets mécaniques d’une décision humaine

Quand l’utilisateur choisit explicitement :

- `response_received`
- `appointment_obtained`
- `ignored`

le backend doit, dans la même unité de travail logique :

1. mettre à jour l’état ;
2. supprimer l’échéance active ;
3. annuler les messages futurs non envoyés ;
4. supprimer, si applicable et possible, leurs brouillons distants Toolbox ;
5. écrire l’historique/audit.

`ignored` doit en plus renforcer `contactability_status=do_not_contact` et ne jamais être réactivé par un import.

## 7. Programmation

VIPER stocke une date/heure précise `scheduled_at` sur le message. Un dispatcher backend exécute périodiquement les messages éligibles.

Conditions minimales d’envoi :

- message état `scheduled` ;
- `scheduled_at <= now` ;
- prospect non `ignored` ;
- prospect pas dans un état qui exige l’annulation de la séquence ;
- remote draft valide disponible ou recréable ;
- envoi non déjà effectué ;
- validation humaine courante encore valide.

Le dispatcher doit être idempotent et restart-safe.

## 8. Dashboard Contact

Métriques verrouillées :

- personnes à traiter cette semaine ;
- dans cette métrique : distinction premier contact / relances ;
- RDV pris cumulés.

Tout compteur additionnel doit être soit dérivé d’un besoin déjà acté, soit ajouté après décision produit. Ne pas gonfler le dashboard par défaut.

## 9. Sécurité

- `OPENAI_API_KEY` côté serveur uniquement ;
- secrets Toolbox/OAuth jamais stockés en clair côté client ;
- aucune donnée personnelle dans les logs applicatifs de debug ;
- conserver l’audit métier sans journaliser le corps complet des emails dans un log global ;
- respecter la politique outbound de la Toolbox.
