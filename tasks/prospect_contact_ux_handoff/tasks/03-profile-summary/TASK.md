# Task 03 — Resume compact du profil et coordonnees

## Goal

Recomposer l'onglet Profil pour qu'il se lise comme une fiche de synthese et non comme un formulaire administratif permanent.

## Context

La reference actuelle est `../../visuals/current-profile-layout.png`. Les blocs Identite et Emploi utilisent de grands inputs et beaucoup d'espace vertical.

## Scope

### In Scope

- resume compact de la personne ;
- rapprochement identite + coordonnees ;
- lecture rapide role / entreprise ;
- distinction claire entre consultation et edition ;
- conservation des donnees et actions existantes.

### Out of Scope

- score visuel, traite en task 04 ;
- changement complet de navigation par onglets ;
- suppression de champs metier.

## Dependencies

Task 00.

## Implementation Steps

1. Charger `/caveman` et `/coding-guideline`.
2. Identifier le pattern de lecture / edition deja utilise ailleurs dans le produit.
3. Construire un resume de profil compact mettant en avant nom, role, entreprise et coordonnees.
4. Reduire le nombre de champs affiches comme gros inputs en mode consultation.
5. Conserver une transition explicite vers l'edition.
6. Garder Emploi comme section informationnelle claire, plus compacte.
7. Determiner ou afficher un eventuel statut de verification d'emploi sans lui redonner une grande carte.
8. Ajouter tests responsive et champs manquants.

## Files Likely Touched

Composant Profil, composants Identite / Coordonnees / Emploi, styles, tests.

## Architecture Constraints

- Ne pas dupliquer les formulaires d'edition ; reutiliser les memes donnees et validations.
- La vue lecture ne doit pas devenir une seconde source d'etat.
- Respecter le design system existant.

## Testing Requirements

- profil complet ;
- e-mail absent ;
- telephone absent ;
- entreprise / role longs ;
- passage lecture -> edition -> sauvegarde ;
- retour lecture apres sauvegarde ;
- largeurs de panneau courantes.

## Acceptance Criteria

- L'identite et les coordonnees principales sont lisibles d'un coup d'oeil.
- L'ecran utilise l'espace pour clarifier la hierarchie, pas pour agrandir les controles.
- L'edition reste disponible et fiable.
- La grande carte de verification n'est plus necessaire a cet emplacement.

## Documentation Updates

Documenter le pattern lecture / edition si nouveau.

## Handoff Notes

Global visual reference: `../../visuals/current-profile-layout.png`.
