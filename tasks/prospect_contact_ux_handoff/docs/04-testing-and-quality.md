# Tests et qualite

## Notes

Verifier :

- zero note ;
- une note ;
- beaucoup de notes ;
- texte long ;
- note avec et sans date ;
- note avec contribution de score positive, negative et nulle ;
- ajout, edition et suppression si deja supportes ;
- absence de debordement horizontal.

## Score

Verifier :

- 0, 1, valeurs medianes, 99, 100 ;
- score indisponible ;
- breakdown vide ;
- contributions positives et negatives ;
- resume long ;
- clic clavier / souris sur la carte ;
- fermeture du detail et retour du focus ;
- couleur non utilisee comme seul vecteur de signification.

## Profil

Verifier :

- champs manquants ;
- e-mail / telephone absents ;
- roles et noms d'entreprise longs ;
- passage consultation -> edition -> sauvegarde ;
- comportement responsive du panneau existant.

## Agent de redaction

Ajouter un test de contrat garantissant que notes et score arrivent bien dans le contexte. Verifier que les informations restent structurees et ne disparaissent pas silencieusement si une partie du score est absente.

## Regression

La refonte ne doit pas casser :

- sauvegarde du profil ;
- navigation entre prospects ;
- actions clavier deja affichees dans la modale ;
- workflow de suivi ;
- autres usages eventuels de la verification d'emploi.
