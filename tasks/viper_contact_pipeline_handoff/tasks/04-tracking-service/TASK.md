# Task 04 — Service backend de suivi manuel

## Goal

Centraliser les mutations humaines d’état et de prochaine semaine dans un service backend testable.

## Context

`updateTracking` est actuellement dans `src/server/index.ts`. La nouvelle règle interdit toute auto-transition et exige des effets mécaniques contrôlés pour certains états.

## Scope
### In Scope
- Service de lecture/mutation du tracking.
- Validation des états cibles.
- Écriture historique/audit.
- Mutation explicite de `next_action_year/week`.
- Préparer les hooks d’annulation de messages pour tâches 12/16.
- Route API dédiée ou refactor des routes prospects existantes.

### Out of Scope
- UI.
- Détection mail/Calendly.
- Auto-Failure.

## Dependencies

Tasks 01-03.

## Implementation Steps

1. Charger les skills code.
2. Extraire la logique de `updateTracking`.
3. Exiger un actor humain authentifié pour les transitions publiques.
4. Ne jamais changer l’état suite à un simple timestamp/email envoyé.
5. Ajouter validations ISO week/year.
6. Ajouter résultats typés et erreurs métier.
7. Ajouter tests API/service.

## Files Likely Touched

- `src/server/index.ts`
- nouveaux services sous `src/server/`
- tests

## Architecture Constraints

- Charger `/caveman` et `/coding-guideline` avant de coder.
- Ne pas ajouter de logique métier stringly-typed dispersée dans `App.tsx` ou `index.ts`.
- Préférer services/adapters testables avec résultats typés.
- Conserver diagnostics explicites et audit métier.
- Ne pas journaliser de PII inutile.

## Testing Requirements

- Changement manuel de chaque état.
- Édition semaine indépendante.
- Historique écrit une seule fois.
- Valeur invalide rejetée.
- Aucun auto-passage en failure.

## Acceptance Criteria

- Les routes ne contiennent plus la logique métier principale.
- Toutes les transitions sont traçables et humaines.
- Le service est utilisable par Prospection et Contact.

## Documentation Updates

Documenter l’API finale si le repo possède une spec API.

## Handoff Notes

L’annulation réelle des messages sera branchée plus tard ; prévoir une interface de dépendance plutôt qu’un import circulaire.
