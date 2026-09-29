# Task 00 — Orchestration du lot

## Goal

Prendre le contrôle du handoff, vérifier les ressources et conduire les tâches jusqu’à une implémentation cohérente sans laisser deux sources de vérité concurrentes.

## Context

Ce dossier est destiné à un agent frais qui n’a pas lu le chat. Le dépôt VIPER existe déjà et contient une V1 fonctionnelle. Le cahier des charges historique est fourni comme référence, mais les décisions du grill du 29/09/2026 supersèdent ses éléments incompatibles.

## Scope
### In Scope
- Lire `README.md`, `grill-session.md`, `docs/*`, `references/source-de-verite.md` et `tasks/TODO.md`.
- Vérifier la branche Git, l’état du working tree, les scripts et les tests existants.
- Vérifier que le dépôt réel correspond encore à l’audit du 29/09/2026.
- Maintenir l’ordre des tâches et modifier les TASK.md si le code réel impose une meilleure découpe.
- Refuser les changements de périmètre silencieux.
- Produire le rapport final à partir du template.

### Out of Scope
- Écrire du code fonctionnel dans cette tâche, sauf micro-correction strictement nécessaire pour pouvoir lancer le projet.
- Modifier le produit avant d’avoir vérifié la branche et la baseline.

## Dependencies

Aucune.

## Implementation Steps

1. Vérifier `git status`, branche active, remote et dernier commit.
2. Lancer la baseline de tests/typecheck/lint/build.
3. Lire le schéma, les routes de tracking, Prospection, Exploitation/Contact placeholder et tests.
4. Comparer le code réel aux docs de ce handoff.
5. Ajuster la liste des tâches uniquement si nécessaire, en documentant pourquoi.
6. Cocher cette tâche dans `tasks/TODO.md` une fois la baseline enregistrée.

## Files Likely Touched

- `tasks/TODO.md`
- éventuellement les TASK.md de ce handoff copiés dans le repo de travail
- rapport de baseline local

## Architecture Constraints

L’orchestrateur doit rester en mode orchestration : une tâche à la fois, critères vérifiés avant passage à la suivante. Toute divergence du plan doit être explicitée et répercutée dans les fichiers de plan.

## Testing Requirements

- Baseline `npm test`, `npm run typecheck`, `npm run lint`, `npm run build`.
- Noter tout échec préexistant avant changement.

## Acceptance Criteria

- Branche et état du dépôt explicitement connus.
- Baseline enregistrée.
- Ordre des tâches confirmé ou révisé par écrit.
- Aucune ambiguïté restante sur quelles décisions du grill supersèdent l’ancien cahier des charges.

## Documentation Updates

Mettre à jour `tasks/TODO.md` avec une courte note de baseline.

## Handoff Notes

Ne pas implémenter en masse dans cette tâche. Son rôle est d’empêcher qu’un agent parte directement sur l’UI sans migration ni contrat.
