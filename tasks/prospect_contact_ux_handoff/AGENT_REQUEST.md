# Demande pour l'agent

Je veux revoir l'UX des fiches prospect/contact, en particulier les onglets **Suivi** et **Profil**.

## 1. Revoir completement l'affichage des notes

Les notes servent a stocker des **faits utiles sur une personne**, par exemple :

- "A like notre post LinkedIn sur IGuard" ;
- "Est marie a la PDG de X" ;
- "Est passionne de baseball" ;
- "Bon interlocuteur sur le sujet Y".

L'affichage actuel prend beaucoup de place et rend ces faits difficiles a parcourir. Je veux une presentation dense, lisible et orientee consultation, pas une succession de gros blocs de formulaire.

Attendu :

- le texte du fait doit etre l'information visuellement dominante ;
- la date, la source et les actions secondaires doivent rester discretes ;
- l'ajout d'une note doit rester tres rapide ;
- eviter les grands espaces vides et les controles qui occupent la carte en permanence ;
- si une note contribue au score, afficher discretement son impact (`+5`, `-10`, etc.) ;
- conserver une experience confortable avec beaucoup de notes.

## 2. Recomposer l'onglet Profil

L'ecran actuel est tres "etat civil + formulaire" et consomme beaucoup d'espace sans ameliorer la lecture.

Je veux une hierarchie d'information plus utile :

- un resume compact de la personne en haut ;
- identite et coordonnees rapprochees dans le meme ensemble ou dans des cartes clairement complementaires ;
- emploi / entreprise lisible rapidement ;
- moins de champs affiches comme de gros inputs quand on est simplement en consultation ;
- conserver la possibilite d'editer sans faire ressembler tout l'ecran a un formulaire permanent.

## 3. Remplacer la carte "Verification de l'emploi" par un score prospect

A l'emplacement actuellement occupe par "Verification de l'emploi", afficher une carte **Score prospect**.

Le score :

- va de `0` a `100` ;
- est presente dans un cercle / anneau de progression ;
- utilise une lecture rouge / jaune / vert selon la qualite du prospect ;
- est accompagne d'un court resume expliquant pourquoi ce contact est interessant ou non ;
- est cliquable pour ouvrir le detail de son calcul.

Le detail doit montrer des contributions explicables, par exemple :

- `+5` — A like notre page / un post ;
- `+10` — Tres bon interlocuteur ;
- `-8` — Poste peu pertinent pour l'offre ;
- etc.

Le scoring est volontairement ajustable et peut evoluer au fur et a mesure. L'important est qu'il soit **explicable**, et que chaque contribution dispose d'une raison claire et, quand c'est possible, d'un lien vers le fait / la note qui la justifie.

Ne pas supprimer aveuglement la logique existante de verification d'emploi : verifier d'abord si elle est utilisee ailleurs. Si elle reste utile, la deplacer vers un statut secondaire dans la zone Emploi plutot que de garder une grande carte dediee.

## 4. Mettre notes et scoring au service de l'agent de redaction

L'agent qui redige les e-mails doit pouvoir recuperer :

- les faits / notes pertinents ;
- le score global ;
- le resume du score ;
- les principales contributions au score.

L'objectif est qu'il puisse identifier le bon angle de personnalisation sans devoir reconstituer lui-meme toute la fiche.

## Contraintes de conception

- priorite a la lisibilite et au scan rapide ;
- densifier l'interface seulement si cela ameliore la comprehension ;
- ne pas cacher les informations importantes derriere trop de clics ;
- eviter l'esthetique "gros formulaire" en mode consultation ;
- ne pas figer dans le front l'algorithme de scoring si un service / modele de donnees peut en etre la source autoritative ;
- respecter le style visuel existant de l'application sauf raison claire de le faire evoluer.

## Points encore ouverts

- regles exactes de calcul du score et valeur de depart ;
- seuils exacts rouge / jaune / vert ;
- attribution des contributions : automatique, manuelle ou hybride ;
- possibilite d'editer directement un delta de score ;
- comportement precis de l'ancienne verification d'emploi apres refonte.

Traiter ces points comme configurables ou proposer une implementation qui ne bloque pas leur evolution future.
