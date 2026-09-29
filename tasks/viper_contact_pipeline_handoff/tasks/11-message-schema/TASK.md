# Task 11 — Schéma des messages Contact/R1/R2

## Goal

Ajouter une persistance durable pour un message par étape et prospect, séparée du système de drafts UI générique.

## Context

Le dépôt possède une table `drafts` pour restaurer de l’état d’interface. Elle ne doit pas devenir la base métier de la campagne Contact.

## Scope
### In Scope
- Table `contact_messages` ou équivalent.
- `prospect_id + step` unique.
- Champs sujet/corps/destinataires/from/status/scheduled/validation/sent/cancel/remote id.
- Événements/audit nécessaires.
- Migration idempotente.
- Repository/service minimal.

### Out of Scope
- UI mail.
- Appel OpenAI.
- Appel Toolbox.
- Pièces jointes si non confirmées.

## Dependencies

Tasks 01-04.

## Implementation Steps

1. Charger les skills code.
2. Implémenter le schéma de `docs/06-data-model.md` adapté au repo.
3. Ajouter repository typé.
4. Ajouter contraintes applicatives.
5. Ajouter tests CRUD et unicité.
6. Vérifier backup/restore.

## Files Likely Touched

- schema/db migration
- nouveaux repository/service
- tests

## Architecture Constraints

- Charger `/caveman` et `/coding-guideline` avant de coder.
- Ne pas ajouter de logique métier stringly-typed dispersée dans `App.tsx` ou `index.ts`.
- Préférer services/adapters testables avec résultats typés.
- Conserver diagnostics explicites et audit métier.
- Ne pas journaliser de PII inutile.

## Testing Requirements

- Créer Contact/R1/R2.
- Unicité par prospect+step.
- Persister scheduled_at/remote id.
- Restore DB.

## Acceptance Criteria

- Les messages survivent au reload/restart.
- Aucun usage de la table générique `drafts` comme source métier.
- Les statuts email sont distincts du statut prospect.

## Documentation Updates

Mettre à jour data-model du repo.

## Handoff Notes

Ne pas stocker une API key ou token Toolbox dans cette table.
