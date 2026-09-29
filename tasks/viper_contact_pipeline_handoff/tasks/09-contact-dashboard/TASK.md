# Task 09 — Dashboard et filtres Contact

## Goal

Construire la vue de priorisation Contact par semaine avec les métriques explicitement actées.

## Context

Contact doit reprendre la disposition de Prospection mais afficher des informations opérationnelles : qui traiter cette semaine et quels rendez-vous ont été obtenus.

## Scope
### In Scope
- API/query pour prospects par prochaine semaine.
- Filtre semaine ISO.
- Compteur “à traiter cette semaine” avec sous-répartition premier contact vs relances.
- Compteur `RDV pris` cumulé.
- Les cartes agissent comme filtres.
- Liste de prospects avec badges état + semaine.

### Out of Scope
- Inventer d’autres KPIs.
- IA/email editor.
- Détection automatique réponse/RDV.

## Dependencies

Task 08 + backend tracking stable.

## Implementation Steps

1. Charger les skills code.
2. Ajouter endpoint agrégé dédié ou enrichir proprement une query Contact.
3. Définir “premier contact” = status neutral avec prochaine semaine ; relance = contacted/r1 avec prochaine semaine correspondante.
4. Définir le sens de R2+week comme revue/clôture, pas relance email supplémentaire.
5. Ajouter sélecteur semaine + cartes filtres.
6. Gérer année ISO.

## Files Likely Touched

- backend queries/routes
- Contact client
- styles
- tests

## Architecture Constraints

- Charger `/caveman` et `/coding-guideline` avant de coder.
- Ne pas ajouter de logique métier stringly-typed dispersée dans `App.tsx` ou `index.ts`.
- Préférer services/adapters testables avec résultats typés.
- Conserver diagnostics explicites et audit métier.
- Ne pas journaliser de PII inutile.

## Testing Requirements

- Semaine courante.
- Semaine future.
- Compteur premier contact vs relances.
- RDV pris cumulés.
- Aucun prospect sans échéance dans le filtre semaine sauf filtre explicite.

## Acceptance Criteria

- Le dashboard Contact répond aux deux métriques actées.
- Cliquer une carte filtre la liste.
- S37/S38/etc. sont filtrables avec année correcte.
- Aucun changement de statut n’est provoqué par un filtre.

## Documentation Updates

Documenter les définitions exactes des compteurs.

## Handoff Notes

Pour `R2 + semaine`, afficher une notion de “revue” dans les détails si nécessaire sans inventer un nouvel état badge.
