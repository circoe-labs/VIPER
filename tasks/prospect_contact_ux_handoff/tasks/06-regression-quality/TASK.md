# Task 06 — Regressions, etats limites et qualite UX

## Goal

Verifier que la refonte ameliore reellement la lisibilite sans casser les workflows existants de la fiche contact.

## Context

Les deux captures d'origine servent de references pour les problemes de densite. La nouvelle UI doit etre comparee a ces references sur le plan de la hierarchie et de l'espace utile.

## Scope

### In Scope

- regression fonctionnelle ;
- etats vides / longs / incomplets ;
- clavier et focus ;
- responsive du panneau ;
- verification des raccourcis existants ;
- controle de la verification d'emploi si elle a ete deplacee ;
- controle du contexte agent.

### Out of Scope

- nouvelle fonctionnalite metier ;
- refonte graphique supplementaire non necessaire.

## Dependencies

Tasks 02 a 05 terminees.

## Implementation Steps

1. Charger `/caveman` et `/coding-guideline` si du code de correction est necessaire.
2. Executer les suites ciblees puis la regression pertinente.
3. Tester les profils incomplets et les longues chaines.
4. Tester un grand nombre de notes.
5. Tester score et breakdown au clavier.
6. Verifier les raccourcis affiches dans la modale (`Ctrl+S`, navigation suivante, fermeture) s'ils existent encore.
7. Verifier sauvegarde et navigation entre prospects.
8. Confirmer que la verification d'emploi, si conservee, reste fonctionnelle.
9. Comparer visuellement la densite a l'ancienne interface.
10. Corriger les regressions et documenter les limites restantes.

## Files Likely Touched

Tests E2E / integration, tests composants, styles de correction, documentation.

## Architecture Constraints

- Les corrections de regression ne doivent pas reintroduire des gros blocs de formulaire par facilite.
- Toute exception visuelle doit etre coherente avec le design system.

## Testing Requirements

Suivre `docs/04-testing-and-quality.md` et ajouter les scenarios propres au projet identifies pendant l'audit.

## Acceptance Criteria

- Les workflows de sauvegarde et navigation restent fonctionnels.
- Les notes restent scannables avec une liste longue.
- Le Profil reste lisible avec donnees manquantes ou longues.
- Le score est accessible et son detail fonctionne au clavier.
- Le contexte agent contient les nouvelles donnees attendues.
- Aucune dependance critique de verification d'emploi n'est cassee.

## Documentation Updates

Produire le rapport final d'implementation.

## Handoff Notes

Global visual references: `../../visuals/current-followup-notes.png` and `../../visuals/current-profile-layout.png`.
