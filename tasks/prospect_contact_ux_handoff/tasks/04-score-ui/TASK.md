# Task 04 — Carte Score prospect et detail des contributions

## Goal

Utiliser l'espace libere par la verification d'emploi pour presenter un score 0-100 utile, explicable et actionnable.

## Context

L'utilisateur veut un cercle / anneau de score, une lecture rouge-jaune-vert, un resume a cote et un detail cliquable des raisons du score.

## Scope

### In Scope

- carte Score prospect ;
- anneau / jauge 0-100 ;
- semantique rouge / jaune / vert ;
- resume court ;
- interaction d'ouverture du breakdown ;
- liste des contributions avec delta + raison + source ;
- etats vide / chargement / erreur.

### Out of Scope

- invention de l'algorithme ;
- pipeline complet de generation automatique des contributions.

## Dependencies

Tasks 01 et 03 terminees.

## Implementation Steps

1. Charger `/caveman` et `/coding-guideline`.
2. Reutiliser les patterns existants pour jauges, drawers, modales ou popovers.
3. Afficher le total dans un anneau clairement lisible.
4. Ajouter un resume textuel a proximite immediate.
5. Utiliser une couleur semantique sans en faire le seul indicateur.
6. Rendre la carte accessible au clavier et clairement interactive.
7. Ouvrir un detail avec contributions, deltas signes, raisons et sources.
8. Afficher un lien vers la note / le fait source si l'architecture le permet.
9. Gerer les etats sans score et sans breakdown.
10. Ajouter tests composants et accessibilite.

## Files Likely Touched

Composant Profil, nouveau composant Score, composant detail, styles, tests.

## Architecture Constraints

- Le composant recoit un contrat de score ; il ne definit pas les regles metier.
- Les seuils couleur doivent etre centralises/configurables si possible.
- Le breakdown doit rester exploitable meme si les contributions proviennent de sources heterogenes.

## Testing Requirements

- scores 0, 1, 50, 99, 100 ;
- bandes de couleur ;
- absence de score ;
- breakdown vide ;
- plusieurs contributions positives et negatives ;
- texte de raison long ;
- clavier, focus et fermeture du detail ;
- contraste et indication non exclusivement coloree.

## Acceptance Criteria

- Le score est visible immediatement dans le Profil.
- Le resume explique en quelques lignes pourquoi le contact est interessant ou non.
- Un clic / activation clavier donne acces au detail.
- Chaque contribution affiche clairement son delta et sa raison.
- L'ancienne grande carte de verification d'emploi n'occupe plus cet espace.

## Documentation Updates

Ajouter la documentation du composant Score et de ses etats si necessaire.

## Handoff Notes

Global visual reference for placement: `../../visuals/current-profile-layout.png`.
