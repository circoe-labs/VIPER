# Task 10 — Workbench Contact split view

## Goal

Créer l’interaction principale Contact : fiche prospect à gauche, zone mailing à droite.

## Context

Dans Contact, cliquer une personne ne doit pas ouvrir l’éditeur de fiche Prospection comme action principale. Le but est de travailler le mail en gardant le contexte visible.

## Scope
### In Scope
- Split view responsive.
- Panneau gauche en lecture prioritaire : identité, entreprise, rôle, coordonnées, contexte, badges.
- Actions minimales pour ouvrir la fiche complète Prospection si correction de données nécessaire.
- Panneau droit réservé à la séquence mail.
- Sélection stable d’un prospect dans la liste.

### Out of Scope
- Modification complète de la fiche dans ce panneau.
- Modèle de message final.
- OpenAI/Toolbox.

## Dependencies

Tasks 08-09.

## Implementation Steps

1. Charger les skills code.
2. Extraire/partager un ProspectSummary plutôt que dupliquer le drawer entier.
3. Construire layout desktop puis responsive raisonnable.
4. Gérer loading/error/empty.
5. Conserver la sélection lors des refresh de liste quand possible.

## Files Likely Touched

- client Contact components
- styles
- éventuellement endpoint prospect detail déjà existant

## Architecture Constraints

- Charger `/caveman` et `/coding-guideline` avant de coder.
- Ne pas ajouter de logique métier stringly-typed dispersée dans `App.tsx` ou `index.ts`.
- Préférer services/adapters testables avec résultats typés.
- Conserver diagnostics explicites et audit métier.
- Ne pas journaliser de PII inutile.

## Testing Requirements

- Prospect sélectionné affiché.
- Changement de sélection.
- États vides/erreur.
- Aucun edit accidentel du prospect depuis le panneau gauche.

## Acceptance Criteria

- La fiche est à gauche et la zone mail à droite.
- Le contexte utile reste lisible pendant l’édition.
- L’utilisateur peut rejoindre la fiche Prospection pour corriger les données.

## Documentation Updates

Documenter le nouveau pattern UI si le repo a une interface-spec.

## Handoff Notes

Le panneau mail peut être un placeholder structuré jusqu’à task 13, mais ne pas inventer de faux email généré.
