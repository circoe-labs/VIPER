# Task 05 — Badges d’état et de semaine réutilisables

## Goal

Créer des composants UI cohérents pour afficher état et prochaine semaine dans Prospection et Contact.

## Context

Le code actuel rend le suivi inline dans la carte Prospection avec fallback `À contacter`. Le nouveau modèle exige deux badges indépendants.

## Scope
### In Scope
- Composant badge d’état.
- Composant badge semaine.
- `neutral` = aucun badge état.
- Affichage Sxx, avec année accessible en tooltip/aria si utile.
- Utilisation sur cartes prospects.
- Styles accessibles et compacts.

### Out of Scope
- Édition du statut.
- Page Contact complète.
- Refonte totale de la DA.

## Dependencies

Tasks 01-04.

## Implementation Steps

1. Charger les skills code.
2. Extraire labels/formatters depuis le contrat partagé.
3. Créer composants réutilisables.
4. Remplacer le rendu tracking actuel dans Prospection.
5. Retirer le fallback UI `À contacter`.
6. Vérifier affichage cartes repliées.

## Files Likely Touched

- `src/client/App.tsx` ou composants extraits
- `src/client/styles.css`
- tests UI si infrastructure disponible

## Architecture Constraints

- Charger `/caveman` et `/coding-guideline` avant de coder.
- Ne pas ajouter de logique métier stringly-typed dispersée dans `App.tsx` ou `index.ts`.
- Préférer services/adapters testables avec résultats typés.
- Conserver diagnostics explicites et audit métier.
- Ne pas journaliser de PII inutile.

## Testing Requirements

- Snapshot/DOM tests si existants.
- Vérifier neutral, Contacté, R1, R2, Réponse reçue, RDV pris, Failure, Ignoré.
- Vérifier semaine sans état.

## Acceptance Criteria

- `neutral + S40` montre S40 sans badge d’état.
- `R1 + S44` montre exactement R1 et S44.
- Les badges sont visibles sans ouvrir la fiche.
- Aucun label `À contacter` n’est utilisé comme état par défaut.

## Documentation Updates

Capturer les conventions de badges dans la doc interface si elle existe.

## Handoff Notes

Ne pas coder la logique de prochaine étape dans le composant visuel ; il ne fait qu’afficher.
