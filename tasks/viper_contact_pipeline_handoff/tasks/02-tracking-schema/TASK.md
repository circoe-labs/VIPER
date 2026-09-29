# Task 02 — Migration du suivi prospect

## Goal

Faire évoluer la persistance `contact_tracking` vers l’état neutre et la sémantique de prochaine échéance sans perdre les données existantes.

## Context

Le schéma actuel impose `status='to_contact'` et stocke `contact_year/contact_week`. Cela encode l’ancien modèle.

## Scope
### In Scope
- Nouveau défaut `neutral`.
- Colonnes de prochaine échéance clairement nommées ou migration contrôlée des colonnes existantes.
- Compatibilité de lecture pendant la migration si nécessaire.
- Migration SQLite idempotente et testée.
- Préserver `contact_tracking_status_history`.

### Out of Scope
- Mapping définitif des données legacy complexes : tâche 03.
- UI.
- Messages email.

## Dependencies

Tasks 00-01.

## Implementation Steps

1. Charger les skills code.
2. Écrire la migration SQLite sans DROP destructif non contrôlé.
3. Faire évoluer le schéma de création pour les nouvelles bases.
4. Ajouter contraintes/validation côté service lorsque SQLite ne permet pas un CHECK simple à migrer.
5. Vérifier backup/restore.
6. Ajouter tests de migration sur base synthétique.

## Files Likely Touched

- `src/server/schema.ts`
- `src/server/db.ts`
- tests migration

## Architecture Constraints

- Charger `/caveman` et `/coding-guideline` avant de coder.
- Ne pas ajouter de logique métier stringly-typed dispersée dans `App.tsx` ou `index.ts`.
- Préférer services/adapters testables avec résultats typés.
- Conserver diagnostics explicites et audit métier.
- Ne pas journaliser de PII inutile.

## Testing Requirements

- Migration sur base vide.
- Migration sur base avec anciens champs.
- Migration répétée deux fois.
- Sauvegarde/restauration si couverte par tests existants.

## Acceptance Criteria

- Nouvelle base crée `neutral`.
- Ancienne base migre sans perte.
- Prochaine semaine peut être NULL.
- Année+semaine restent cohérentes aux frontières d’année.

## Documentation Updates

Mettre à jour la doc de modèle de données du repo si elle existe.

## Handoff Notes

Ne pas supprimer immédiatement des colonnes legacy si cela met la migration en danger ; préférer une migration en deux temps documentée.
