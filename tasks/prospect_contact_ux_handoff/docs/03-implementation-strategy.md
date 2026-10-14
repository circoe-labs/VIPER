# Strategie d'implementation

## Ordre recommande

1. Auditer les composants et donnees existants de la fiche contact.
2. Stabiliser le contrat du scoring avant d'implanter fortement l'UI.
3. Refaire l'affichage des notes sans attendre la logique avancee de scoring.
4. Recomposer le haut du profil en mode lecture plus compact.
5. Ajouter la carte score et son detail.
6. Exposer les informations a l'agent de redaction.
7. Ajouter les regressions, etats limites et controles d'accessibilite.

## Principe de migration

Preferer une migration progressive :

- reutiliser les donnees existantes ;
- ne pas casser l'edition ;
- conserver les routes / API publiques tant que possible ;
- ajouter le nouveau contrat de score derriere un adapter si le backend actuel a un format different.

## Verification d'emploi

Avant toute suppression :

- identifier le composant ;
- identifier la donnee associee ;
- rechercher ses consommateurs ;
- verifier s'il existe des workflows dependants.

Si la fonction reste necessaire, la reduire a un statut secondaire dans la zone Emploi ou un sous-panneau de detail.

## Strategie visuelle

Respecter les tokens, espacements, composants et interactions existants. Le but est d'ameliorer la hierarchie et la densite, pas de lancer une refonte graphique parallele.
