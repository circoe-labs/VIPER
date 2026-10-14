# Task 01 — Contrat de scoring prospect

## Goal

Introduire un contrat de donnees stable pour representer un score 0-100, son resume et ses contributions explicables, sans figer prematurely l'algorithme commercial.

## Context

L'UI doit afficher un total et pouvoir ouvrir un detail du type `+5 — a like un post`, `+10 — tres bon interlocuteur`, `-8 — faible pertinence du poste`.

## Scope

### In Scope

- type / schema du score ;
- type / schema des contributions ;
- source autoritative du total ;
- adapter si le backend existant a un autre format ;
- etats score absent / breakdown absent.

### Out of Scope

- definition definitive des regles commerciales ;
- automatisation complete de tous les signaux ;
- UI du score.

## Dependencies

Task 00 terminee.

## Implementation Steps

1. Charger `/caveman` et `/coding-guideline`.
2. Verifier si un modele de score existe deja.
3. Definir un contrat equivalent a `ProspectScore { total, summary, contributions[] }`.
4. Ajouter les champs de provenance necessaires pour relier une contribution a une note / un fait lorsque possible.
5. S'assurer que le total reste borne entre 0 et 100 au niveau approprie.
6. Ne pas hardcoder les seuils rouge / jaune / vert dans le modele si une config est preferable.
7. Ajouter tests de schema / serialization / adapter.

## Files Likely Touched

A determiner apres audit : types de domaine, schema API, service de scoring, adapter frontend, fixtures et tests.

## Architecture Constraints

- Le composant visuel ne doit pas etre la source de verite du calcul.
- Les contributions doivent rester explicables et tracables.
- Les regles de scoring doivent pouvoir evoluer sans casser le contrat d'affichage.
- Preferer un resultat type explicite a un dictionnaire ad hoc.

## Testing Requirements

- total 0, valeurs intermediaires, 100 ;
- contribution positive et negative ;
- score sans contribution ;
- score absent ;
- source_ref optionnelle ;
- invalidation / clamp si donnees hors bornes selon l'architecture existante.

## Acceptance Criteria

- Un consommateur UI peut afficher le total, le resume et le breakdown sans connaitre l'algorithme.
- Les contributions contiennent au minimum `delta` et `reason`.
- Les points ouverts restent configurables ou documentes.
- Les tests du contrat passent.

## Documentation Updates

Mettre a jour la documentation du modele si le projet en maintient une.

## Handoff Notes

Ne pas choisir silencieusement une base de score ou des seuils de couleur non valides par le produit.
