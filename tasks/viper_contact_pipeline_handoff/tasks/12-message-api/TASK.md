# Task 12 — API et machine d’état des messages

## Goal

Implémenter le cycle Brouillon/Validé/Programmé/Envoyé/Annulé avec revalidation obligatoire après édition.

## Context

La validation humaine de chaque email est une règle centrale. Une génération ou une édition ne doit jamais rendre le message envoyable sans validation courante.

## Scope
### In Scope
- GET/PUT pour Contact/R1/R2.
- Action validate.
- Action schedule.
- Action cancel.
- Action mark sent réservée à l’adapter/dispatcher.
- Édition d’un validated/scheduled => retour draft.
- sent immuable.
- Audit et actor.

### Out of Scope
- OpenAI.
- Toolbox réel.
- Scheduler.

## Dependencies

Task 11 + auth/audit existants.

## Implementation Steps

1. Charger les skills code.
2. Créer service de machine d’état.
3. Définir erreurs métier typées.
4. Exposer routes minces.
5. Invalider validation et remote draft de façon transactionnelle/diagnostiquée lors d’une édition.
6. Ajouter tests exhaustive state transitions.

## Files Likely Touched

- service messages
- routes API
- tests

## Architecture Constraints

- Charger `/caveman` et `/coding-guideline` avant de coder.
- Ne pas ajouter de logique métier stringly-typed dispersée dans `App.tsx` ou `index.ts`.
- Préférer services/adapters testables avec résultats typés.
- Conserver diagnostics explicites et audit métier.
- Ne pas journaliser de PII inutile.

## Testing Requirements

- Toutes transitions légales.
- Toutes transitions illégales.
- Modification validated/scheduled.
- Sent immutable.
- scheduled sans date rejeté.

## Acceptance Criteria

- Un draft non validé ne peut atteindre sent.
- La validation est liée à la version actuelle du contenu.
- Une édition force une nouvelle validation humaine.
- Les routes ne permettent pas à un client d’usurper `sent`.

## Documentation Updates

Documenter la machine d’état dans l’API/architecture repo.

## Handoff Notes

Prévoir une méthode de service interne pour le dispatcher au lieu d’exposer “mark sent” publiquement.
