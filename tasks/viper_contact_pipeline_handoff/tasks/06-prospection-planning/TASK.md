# Task 06 — Planification depuis Prospection

## Goal

Permettre à l’humain de choisir/modifier la prochaine semaine d’un prospect depuis Prospection sans lui imposer de statut d’état.

## Context

Le workflow cible commence par une fiche neutre. L’humain peut décider « cette personne, S40 ». Cette semaine fait ensuite remonter le prospect dans Contact.

## Scope
### In Scope
- Contrôle année/semaine dans l’éditeur prospect ou action rapide.
- Sauvegarde via le service de tracking.
- `neutral` conservé quand seul le planning change.
- Proposition optionnelle de génération des emails après planification, mais aucun appel IA dans cette tâche.
- Filtres par semaine si nécessaire à Prospection.

### Out of Scope
- Génération IA.
- Envoi.
- Changement automatique vers Contacté.

## Dependencies

Tasks 04-05.

## Implementation Steps

1. Charger les skills code.
2. Ajouter UI de semaine simple et claire.
3. Stocker année ISO + semaine.
4. Ne pas créer de faux statut `to_contact`.
5. Recharger liste/badges après save.
6. Couvrir changement d’année.

## Files Likely Touched

- `src/client/App.tsx` / composants
- API tracking
- styles
- tests

## Architecture Constraints

- Charger `/caveman` et `/coding-guideline` avant de coder.
- Ne pas ajouter de logique métier stringly-typed dispersée dans `App.tsx` ou `index.ts`.
- Préférer services/adapters testables avec résultats typés.
- Conserver diagnostics explicites et audit métier.
- Ne pas journaliser de PII inutile.

## Testing Requirements

- Planifier S40 depuis neutral.
- Modifier S40->S41.
- Supprimer l’échéance.
- Vérifier aucun changement de status implicite.

## Acceptance Criteria

- Une personne peut être neutral sans semaine.
- Une personne peut être neutral + semaine.
- Aucun badge état n’apparaît tant que l’humain n’en choisit pas un.
- La semaine apparaît immédiatement sur la carte.

## Documentation Updates

Mettre à jour la doc interface Prospection.

## Handoff Notes

Si l’UI demande “générer maintenant ?”, le bouton doit être un simple embranchement vers la future fonctionnalité et ne pas créer de faux contenu avant task 14.
