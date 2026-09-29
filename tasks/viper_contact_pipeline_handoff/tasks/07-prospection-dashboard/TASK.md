# Task 07 — Nettoyage du dashboard Prospection

## Goal

Retirer les métriques contradictoires et réduire la densité du haut de page Prospection sans inventer la formule de complétude.

## Context

Le dashboard actuel expose 8 compteurs dont Non vérifiés/Vérifiés/Incomplets/À contacter, alors que la session demande une lecture plus concise de la santé de la donnée et supprime la notion de validation globale.

## Scope
### In Scope
- Retirer les compteurs qui utilisent `unknown` ou valident globalement le prospect.
- Limiter l’espace à 4-6 cartes maximum.
- Conserver uniquement les métriques déjà réellement définies ou facilement factuelles.
- Rendre les cartes cliquables comme filtres quand le sens est non ambigu.
- Ne pas coder de score de complétude pondéré tant que sa formule n’est pas actée.

### Out of Scope
- Inventer une pondération de complétude.
- Ajouter des graphes décoratifs sans besoin.
- Refaire le Home global.

## Dependencies

Tasks 05-06.

## Implementation Steps

1. Charger les skills code.
2. Identifier les métriques contradictoires.
3. Réduire le set en préservant au minimum total prospects et métriques réellement supportées.
4. Retirer les filtres `never_verified`/`verified` si leur sémantique globale contredit le modèle ; garder des signaux de qualité dans la fiche si utiles.
5. Vérifier que la liste reste le contenu principal visible sans scroll excessif.

## Files Likely Touched

- `src/client/App.tsx`
- `src/server/index.ts` dashboard/queries si nécessaire
- styles

## Architecture Constraints

- Charger `/caveman` et `/coding-guideline` avant de coder.
- Ne pas ajouter de logique métier stringly-typed dispersée dans `App.tsx` ou `index.ts`.
- Préférer services/adapters testables avec résultats typés.
- Conserver diagnostics explicites et audit métier.
- Ne pas journaliser de PII inutile.

## Testing Requirements

- Tests des compteurs conservés.
- Vérifier absence de compteur pipeline `Inconnu`.
- Vérifier maximum 6 cartes.

## Acceptance Criteria

- Le haut de Prospection est sensiblement plus compact.
- Aucun compteur ne prétend qu’un prospect entier est validé/non validé.
- La liste de prospects reste visible rapidement.

## Documentation Updates

Noter explicitement que la formule “complétude moyenne de la base” reste ouverte.

## Handoff Notes

Ne pas bloquer le lot Contact sur la métrique de complétude.
