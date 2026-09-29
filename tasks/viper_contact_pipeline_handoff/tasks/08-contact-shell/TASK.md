# Task 08 — Renommer Exploitation en Contact

## Goal

Remplacer le placeholder Exploitation par une page Contact réelle mais encore sans logique mail complexe.

## Context

`App.tsx` contient actuellement `page='exploitation'` et un composant Coming soon. Le produit demande désormais Prospection / Contact.

## Scope
### In Scope
- Navigation `Contact`.
- Identifiant de page/route propre.
- Titre/sous-titre orientés actions de contact.
- Skeleton liste + zone principale prête à recevoir dashboard/workbench.
- Migration de préférence locale `viper.ui.page` si `exploitation` était mémorisé.

### Out of Scope
- Messages réels.
- OpenAI.
- Toolbox.

## Dependencies

Tasks 05-07.

## Implementation Steps

1. Charger les skills code.
2. Renommer le concept dans le client.
3. Gérer le cas localStorage ancien `exploitation`.
4. Créer le composant Contact séparé de Prospection.
5. Préparer composants réutilisables plutôt que copier-coller massif.

## Files Likely Touched

- `src/client/App.tsx` ou nouveaux composants
- styles

## Architecture Constraints

- Charger `/caveman` et `/coding-guideline` avant de coder.
- Ne pas ajouter de logique métier stringly-typed dispersée dans `App.tsx` ou `index.ts`.
- Préférer services/adapters testables avec résultats typés.
- Conserver diagnostics explicites et audit métier.
- Ne pas journaliser de PII inutile.

## Testing Requirements

- Navigation vers Contact.
- Retour page après reload.
- Ancienne valeur localStorage ne casse pas l’app.

## Acceptance Criteria

- Aucun label Exploitation dans la navigation utilisateur.
- La page Contact n’affiche plus “Coming soon”.
- Pas de données fictives.

## Documentation Updates

Mettre à jour README/implementation report quand la fonctionnalité devient réelle.

## Handoff Notes

Le nom interne `exploitation` peut être migré temporairement mais ne doit pas rester la nouvelle API publique UI.
