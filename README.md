# VIPER V1 — branche GPT

Implémentation V1 orientée **base de données + interface humaine**, conforme au handoff revu du 10 septembre 2026.

## Inclus
Authentification mono-utilisateur, base SQLite normalisée, audit/provenance, Home, Prospection, édition prospect, suivi de contact, import XLSX contrôlé, export normalisé, Database Explorer, SQL read-only côté serveur, Settings, recherche globale et Exploitation en placeholder explicite.

Aucun IProspect/IContact, envoi email, synchronisation Calendly ou CRM riche n'est simulé.

## Démarrage

```bash
cp .env.example .env
npm install
npm run migrate
npm run seed
npm run dev
```

Identifiants de développement par défaut : `commercial@example.test` / `change-me-now`. À remplacer hors développement.

## Données privées
Le classeur réel `BASE_CLIENT.xlsx` n'est jamais commité. `.gitignore` et la CI bloquent explicitement sa publication. Les tests n'emploient que des données synthétiques.

## Limite explicitement non masquée
Le Database Explorer propose la lecture technique et la console SQL read-only ; le niveau DBeaver complet pour les mutations génériques avancées reste partiel et est marqué comme tel dans `tasks-status.md` et `docs/IMPLEMENTATION_REPORT.md`.
