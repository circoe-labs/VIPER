# Task 17 — Régression, hardening, docs et rapport final

## Goal

Valider le lot de bout en bout, supprimer les anciennes sémantiques visibles et produire un rapport d’implémentation exploitable.

## Context

Cette tâche clôt le handoff. Elle doit détecter les reliquats `to_contact`, « Inconnu », « Exploitation », statuts post-RDV et toute automatisation métier non voulue.

## Scope
### In Scope
- Suite complète tests/typecheck/lint/build.
- Recherche de strings legacy dans code/UI.
- Tests migration.
- Tests parcours manuel Contact.
- Tests IA avec fake et intégration optionnelle sandbox si disponible.
- Tests Toolbox avec fake et intégration contrôlée si disponible.
- Mise à jour docs/README/tasks-status/implementation report du repo.
- Rapport final basé sur template.

### Out of Scope
- Ajouter de nouvelles fonctionnalités.
- Étendre au CRM post-RDV.
- Ajouter réponse mail auto/Calendly.

## Dependencies

Toutes les tâches précédentes.

## Implementation Steps

1. Charger les skills code.
2. Lancer toutes les gates.
3. Grep des strings legacy et classifier chaque occurrence restante.
4. Vérifier DB de test migrée.
5. Exécuter scénario E2E manuel/documenté : neutral+S40 -> draft -> génération -> validation -> programmation -> envoi -> statut humain.
6. Exécuter scénario réponse manuelle annulant R1/R2.
7. Exécuter scénario ignored + réimport.
8. Mettre à jour documentation et rapport final.

## Files Likely Touched

- docs du repo
- README
- tasks-status.md
- tests éventuels
- rapport final

## Architecture Constraints

- Charger `/caveman` et `/coding-guideline` avant de coder.
- Ne pas ajouter de logique métier stringly-typed dispersée dans `App.tsx` ou `index.ts`.
- Préférer services/adapters testables avec résultats typés.
- Conserver diagnostics explicites et audit métier.
- Ne pas journaliser de PII inutile.

## Testing Requirements

- `npm test`
- `npm run typecheck`
- `npm run lint`
- `npm run build`
- scénario migration legacy
- scénario double-send

## Acceptance Criteria

- Toutes gates vertes ou blocages documentés.
- Aucun comportement automatique interdit.
- Aucun statut legacy visible.
- Contact fonctionne avec données persistantes.
- Rapport final décrit migrations, config, risques et tests.

## Documentation Updates

Mettre à jour le cahier des charges/source de vérité du repo pour intégrer ces décisions avant de considérer le lot clos.

## Handoff Notes

Le rapport doit distinguer ce qui est réellement connecté en production de ce qui est seulement testé avec fake adapter.
