# Session reconstruite

This is a reconstructed grill session based on available conversation context.

## Contexte fourni

L'utilisateur montre deux captures de la fiche contact :

1. Onglet `Suivi`, avec une grande carte "Suivi de contact" et une carte "Notes". La zone Notes contient du texte explicatif, un etat vide, un champ "Fait", une date et un bouton Ajouter.
2. Onglet `Profil`, avec de grandes cartes `Identite`, `Emploi`, `Verification de l'emploi` et `Entreprise`.

## Besoin exprime

### Notes

L'utilisateur juge l'affichage actuel trop volumineux et peu lisible. Les notes doivent representer des faits utiles sur une personne : relation avec un decideur, interaction sociale, centres d'interet, qualite d'interlocuteur, etc.

Il veut que ces faits soient faciles a parcourir et utilisables par un agent qui redige des e-mails personnalises.

### Profil

L'utilisateur trouve l'onglet trop proche d'un formulaire administratif. Civilite, prenom, nom et autres champs prennent beaucoup d'espace sans rendre la fiche plus facile a comprendre.

Il suggere de rapprocher l'identite et les coordonnees et de donner a chaque carte une fonction informationnelle plus claire.

### Scoring

L'utilisateur veut remplacer la carte `Verification de l'emploi` par un score de 0 a 100, represente visuellement par un cercle colore rouge / jaune / vert et accompagne d'un resume.

Le score doit etre cliquable. Le detail doit expliquer les contributions, par exemple `+5` pour une interaction sociale ou `+10` pour un bon interlocuteur.

Le scoring est considere comme arbitraire et ajustable, mais doit devenir une synthese exploitable du potentiel de la personne.

### Usage par l'agent de mails

Les notes et le scoring doivent alimenter l'agent de redaction afin qu'il trouve rapidement un angle d'approche personnalise.

## Decisions considerees comme acquises

- Les notes sont des faits, pas de longs comptes-rendus.
- Leur presentation actuelle doit etre densifiee et rendue beaucoup plus scannable.
- Le profil doit moins ressembler a un grand formulaire permanent.
- Identite et coordonnees doivent etre rapprochees dans la hierarchie d'information.
- Une carte de score 0-100 prend la place visuelle de la grande carte de verification d'emploi.
- Le score a une representation visuelle rouge / jaune / vert.
- Le score a un resume court.
- Cliquer sur le score ouvre un detail explicable des contributions positives et negatives.
- Notes et scoring doivent etre accessibles au contexte de l'agent de redaction.

## Points non resolus

- Formule exacte du score.
- Valeur de depart / base du score.
- Seuils de couleurs.
- Automatisation des contributions.
- Mode d'edition des contributions.
- Conservation ou deplacement exact de la verification d'emploi existante.
- Format final pixel-perfect des nouvelles cartes.
