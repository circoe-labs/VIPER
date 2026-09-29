# Task 01 — Contrat de workflow partagé

## Goal

Créer un contrat partagé unique pour les états prospects, labels UI, étapes Contact/R1/R2 et cadence par défaut.

## Context

Le code actuel disperse les statuts sous forme de strings dans `App.tsx` et `index.ts`. La nouvelle taxonomie doit devenir une source de vérité technique avant toute migration.

## Scope
### In Scope
- Enum/type pour `neutral`, `contacted`, `r1`, `r2`, `response_received`, `appointment_obtained`, `failure`, `ignored`.
- Labels UI exacts.
- Enum/type des étapes message `contact`, `r1`, `r2`.
- Cadence +2 / +2 / +4 semaines sous forme de helper pur.
- Fonctions de validation et ordre d’affichage.
- Tests unitaires purs.

### Out of Scope
- Migration SQL.
- UI.
- Envoi email.
- Auto-transition de statut.

## Dependencies

Task 00 terminée.

## Implementation Steps

1. Charger `/caveman` et `/coding-guideline`.
2. Créer un module partagé approprié.
3. Interdire les valeurs legacy dans le nouveau contrat public.
4. Ajouter helpers ISO week/year testables, notamment aux frontières d’année.
5. Ajouter tests unitaires.
6. Remplacer seulement les constantes sans effet comportemental si cela reste sûr ; sinon laisser aux tâches suivantes.

## Files Likely Touched

- nouveau module partagé sous `src/shared/` ou emplacement équivalent
- tests unitaires

## Architecture Constraints

- Charger `/caveman` et `/coding-guideline` avant de coder.
- Ne pas ajouter de logique métier stringly-typed dispersée dans `App.tsx` ou `index.ts`.
- Préférer services/adapters testables avec résultats typés.
- Conserver diagnostics explicites et audit métier.
- Ne pas journaliser de PII inutile.

## Testing Requirements

- Tests sur labels et états.
- Tests de +2/+2/+4 semaines, y compris S52/S01.
- Typecheck.

## Acceptance Criteria

- Une seule définition technique des états cibles.
- `neutral` n’a pas de label badge utilisateur.
- `appointment_obtained` affiche `RDV pris`.
- Aucun helper ne change automatiquement un statut.

## Documentation Updates

Documenter le module dans le rapport d’implémentation si le dépôt possède une doc architecture.

## Handoff Notes

Cette tâche doit rendre les suivantes moins stringly-typed ; ne pas la contourner avec de nouvelles constantes locales.
