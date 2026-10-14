# Task 00 — Orchestration et audit initial

## Goal

Prendre possession de la refonte, cartographier l'implementation actuelle et confirmer un plan d'execution fiable avant de modifier le comportement.

## Context

Le handoff contient deux captures de l'interface actuelle dans `../../visuals/`. Elles servent de references de probleme, pas de design final.

## Scope

### In Scope

- identifier composants, routes, stores, schemas et API utilises par Profil, Suivi, Notes et Verification de l'emploi ;
- identifier le pipeline de contexte utilise par l'agent de redaction ;
- identifier le design system / composants reutilisables ;
- verifier si un scoring existe deja ;
- mettre a jour `tasks/TODO.md` si l'ordre doit evoluer.

### Out of Scope

- refonte visuelle complete ;
- changements metier majeurs ;
- suppression de donnees.

## Dependencies

Aucune.

## Implementation Steps

1. Se mettre explicitement en mode orchestration.
2. Lire tout le dossier de handoff.
3. Localiser les implementations actuelles correspondant aux deux captures.
4. Cartographier les donnees de notes et verification d'emploi.
5. Rechercher tout score ou signal commercial deja present.
6. Localiser la construction du contexte pour l'agent de redaction.
7. Mettre a jour le plan si necessaire, avec justification.
8. Ne lancer la tache 01 qu'apres avoir confirme les dependances.

## Files Likely Touched

- `tasks/TODO.md` si le plan doit etre ajuste.
- Aucun fichier produit ne devrait etre modifie avant la fin de l'audit, sauf documentation.

## Architecture Constraints

- Ne pas supposer le framework, le store ou le format API sans verification.
- Ne pas dupliquer une abstraction existante de scoring ou de contexte agent.

## Testing Requirements

Pas de test produit requis si aucun code produit n'est modifie. Verifier toutefois que les chemins identifies sont bien ceux charges par l'interface actuelle.

## Acceptance Criteria

- Les composants responsables des deux ecrans sont identifies.
- Les sources de donnees Notes, Profil, Emploi et Verification sont identifiees.
- Le pipeline vers l'agent de redaction est identifie.
- Les risques de suppression / migration sont notes.
- `tasks/TODO.md` reflete le vrai ordre d'execution.

## Documentation Updates

Ajouter les constats importants au journal de la tache ou au rapport final.

## Handoff Notes

Global visual references: `../../visuals/current-followup-notes.png` and `../../visuals/current-profile-layout.png`.
