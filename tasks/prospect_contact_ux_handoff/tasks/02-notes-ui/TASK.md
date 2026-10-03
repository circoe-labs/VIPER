# Task 02 — Refonte de l'affichage des notes

## Goal

Transformer la zone Notes en liste compacte de faits, facile a parcourir et rapide a enrichir.

## Context

La reference actuelle est `../../visuals/current-followup-notes.png`. La carte occupe beaucoup d'espace alors qu'elle doit surtout permettre de lire des faits courts.

## Scope

### In Scope

- affichage dense des notes ;
- hierarchie texte du fait > metadonnees > actions ;
- ajout rapide d'un fait ;
- delta de score discret si disponible ;
- etats vide, long texte, beaucoup de notes ;
- preservation des actions existantes utiles.

### Out of Scope

- moteur de scoring ;
- collecte automatique de nouveaux signaux ;
- refonte du reste de l'onglet Suivi.

## Dependencies

Task 00 ; Task 01 uniquement si l'affichage du delta depend du nouveau contrat.

## Implementation Steps

1. Charger `/caveman` et `/coding-guideline`.
2. Identifier le composant Notes actuel et son mode d'edition.
3. Remplacer la presentation volumineuse par des lignes/items compacts.
4. Mettre le `fact_text` en premier plan.
5. Deplacer date / source / actions dans une zone secondaire concise.
6. Integrer un badge delta si une contribution existe.
7. Rendre l'ajout de note rapide ; eviter d'afficher en permanence des controles disproportionnes.
8. Gerer un grand nombre de notes sans faire exploser la hauteur du panneau.
9. Ajouter tests composants et interactions.

## Files Likely Touched

Composant Notes, formulaire / quick-add, styles, types de note, tests frontend.

## Architecture Constraints

- Ne pas creer une nouvelle carte lourde pour chaque note.
- Garder l'edition accessible sans transformer le mode lecture en formulaire.
- Reutiliser les composants de liste, overflow menu, badge et date existants si disponibles.

## Testing Requirements

- 0, 1 et beaucoup de notes ;
- texte court et long ;
- note avec / sans date ;
- note avec / sans source ;
- delta positif / negatif ;
- ajout clavier et souris ;
- navigation focus ;
- absence de regression de sauvegarde.

## Acceptance Criteria

- Plusieurs faits sont visibles simultanement dans l'espace ou l'ancienne carte n'en montrait pratiquement aucun.
- Le fait est l'element le plus facile a lire.
- L'ajout reste rapide.
- Les metadonnees ne dominent pas visuellement.
- Le composant reste utilisable avec une liste longue.

## Documentation Updates

Documenter tout nouveau pattern de note reutilisable si le projet possede une bibliotheque UI interne.

## Handoff Notes

Global visual reference: `../../visuals/current-followup-notes.png`.
