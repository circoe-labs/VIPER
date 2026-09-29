# 05 — Audit du dépôt actuel

Audit effectué le 29 septembre 2026 à partir du dépôt `circoe-labs/VIPER` via GitHub.

## Stack observée

- TypeScript
- React + Vite
- Express
- SQLite via `better-sqlite3`
- Vitest
- Zod disponible
- XLSX

Scripts déclarés : `dev`, `build`, `start`, `test`, `typecheck`, `lint`, `migrate`, `seed`.

## Fichiers structurants observés

### `src/server/schema.ts`

Le schéma actuel contient notamment :

- `prospects.activity_status` avec défaut `unknown` ;
- `prospects.contactability_status` ;
- `contact_tracking` avec `status TEXT NOT NULL DEFAULT 'to_contact'` ;
- `planned_contact_at`, `contact_year`, `contact_week` ;
- `contact_tracking_status_history` ;
- table générique `drafts` pour du state UI, pas pour le futur modèle d’email Contact.

### `src/server/index.ts`

Le serveur est actuellement assez monolithique. Il contient :

- helpers prospect/email/téléphone ;
- `updateTracking` ;
- `/api/dashboard` ;
- routes de drafts génériques ;
- routes prospects et imports plus bas dans le fichier.

`updateTracking` utilise encore `to_contact` comme défaut et génère automatiquement `response_received_at` quand le statut devient `response_received`. Ce timestamp automatique au moment d’une **action humaine** reste compatible, mais le choix du statut doit rester humain.

### `src/client/App.tsx`

Le client est lui aussi très centralisé.

Navigation actuelle :

```text
Accueil
Prospection
Exploitation
Base de données
Paramètres
```

`trackingLabels` contient actuellement :

```text
to_contact -> À contacter
contacted -> Contacté
follow_up_1 -> Relance 1
follow_up_2 -> Relance 2
response_received -> Réponse reçue
appointment_obtained -> Rendez-vous obtenu
quote_sent -> Devis envoyé
quote_follow_up -> Devis relancé
won -> Commande passée
not_interested -> Non intéressé
```

La page Prospection affiche encore huit compteurs et une colonne de suivi qui retombe sur `À contacter` par défaut.

Le rendu de l’identité utilise encore le mot `Inconnu` si prénom/nom manquent, et l’éditeur expose `Statut d’activité: Actif / Inconnu / Inactif`.

La page `Exploitation` est actuellement :

> surface volontairement réservée ; aucun brouillon, agent, envoi ou métrique fictive n’est simulé.

Elle est donc le point naturel à remplacer par la page Contact.

## README / état du projet

Le README indique :

- V1 orientée base + interface humaine ;
- envoi email / IContact non encore implémentés ;
- stockage SQLite persistant hors checkout ;
- branche de travail locale `GPT` suivant `origin/GPT`.

## Conséquence pour ce handoff

La refonte doit être réalisée comme une **migration sémantique** et non comme un simple renommage :

- la base persiste d’anciens statuts ;
- les filtres et dashboards utilisent ces statuts ;
- le mot « Inconnu » apparaît dans plusieurs dimensions ;
- la page Contact n’existe pas encore ;
- il n’existe pas encore de modèle durable de messages Contact/R1/R2.
