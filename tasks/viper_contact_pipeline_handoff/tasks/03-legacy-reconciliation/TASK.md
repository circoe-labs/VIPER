# Task 03 — Réconciliation des données legacy

## Goal

Convertir les anciens statuts dans la nouvelle taxonomie de façon explicite, auditable et sûre.

## Context

Le dépôt possède des enregistrements potentiels en `to_contact`, `follow_up_1`, statuts post-RDV, etc. Le nouveau scope Contact s’arrête au rendez-vous.

## Scope
### In Scope
- Implémenter le mapping de `docs/06-data-model.md`.
- Préserver l’ancien statut dans historique/audit lorsque plusieurs anciens états convergent.
- `not_interested`: `ignored` uniquement si blocage durable ; sinon `failure`.
- `to_contact` -> `neutral` tout en conservant la prochaine semaine.
- Rapport de compteurs avant/après.
- Pas de changement de `do_not_contact` vers contactable.

### Out of Scope
- Nettoyage général de `activity_status`.
- Suppression physique de données.
- Réécriture de l’historique ancien.

## Dependencies

Task 02.

## Implementation Steps

1. Charger les skills code.
2. Écrire la migration/reconciliation avec dry-run testable si faisable.
3. Ajouter fixtures synthétiques pour chaque statut legacy.
4. Vérifier la convergence des statuts post-RDV vers `appointment_obtained`.
5. Vérifier `not_interested` + do_not_contact.
6. Journaliser un résumé non-PII de la migration.

## Files Likely Touched

- migration/service de migration
- tests migration
- éventuellement script diagnostic

## Architecture Constraints

- Charger `/caveman` et `/coding-guideline` avant de coder.
- Ne pas ajouter de logique métier stringly-typed dispersée dans `App.tsx` ou `index.ts`.
- Préférer services/adapters testables avec résultats typés.
- Conserver diagnostics explicites et audit métier.
- Ne pas journaliser de PII inutile.

## Testing Requirements

- Une fixture par statut legacy.
- Compteurs avant/après stables.
- Aucun prospect perdu.
- Historique conservé.

## Acceptance Criteria

- Tous les anciens états sont convertis ou explicitement signalés.
- Aucun `to_contact`, `follow_up_1`, `follow_up_2`, `quote_sent`, `quote_follow_up`, `won`, `not_interested` ne reste comme valeur active du nouveau contrat.
- Le résultat respecte `do_not_contact`.

## Documentation Updates

Documenter le mapping effectivement exécuté.

## Handoff Notes

Si des valeurs inattendues existent en production, ne pas les écraser : arrêter/diagnostiquer ou les placer dans une file de revue explicite.
