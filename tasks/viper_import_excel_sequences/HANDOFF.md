# HANDOFF IMPLEMENTATION - VIPER

## Refonte import Excel et gestion des séquences de contact

**Branche de référence :** `task/contact-port`\
**Projet :** VIPER (Validation Interface for Prospecting, Execution &
Revenue)\
**Objectif :** permettre à un agent d'implémentation de réaliser la
refonte de l'import Excel et du système de suivi des séquences de
prospection conformément aux décisions métier validées.

------------------------------------------------------------------------

# 1. Contexte

La session de travail a permis de revoir entièrement la logique d'import
Excel et de suivi des prospects dans VIPER.

Le problème actuel vient principalement d'une mauvaise interprétation
des données :

-   confusion entre validation du prospect et validation de l'email ;
-   confusion entre semaine Sxx et semaine calendrier ISO ;
-   mélange entre état commercial et qualité de donnée ;
-   écrasement potentiel des corrections humaines lors des imports ;
-   gestion des relances trop rigide avec des statuts fixes.

Le principe directeur devient :

> L'humain valide la donnée métier. VIPER structure, affiche et pilote.
> L'IA détecte les incohérences mais ne modifie jamais seule une
> décision métier.

------------------------------------------------------------------------

# 2. Référence technique

L'implémentation doit partir de la branche :

    task/contact-port

L'agent doit analyser l'existant avant modification afin de conserver
: - architecture actuelle ; - conventions de code ; - modèles de données
existants ; - composants UI déjà développés.

Les changements doivent être intégrés sans casser les fonctionnalités
existantes.

------------------------------------------------------------------------

# 3. Règles générales de priorité des données

Ordre de confiance :

1.  Modification humaine réalisée dans VIPER
2.  Import Excel validé humainement
3.  Analyse IA / suggestion

Un nouvel import ne doit jamais écraser silencieusement : - une
correction humaine ; - un changement manuel de statut ; - une
modification de séquence.

En cas de conflit : - conserver la donnée humaine ; - créer une alerte
visible.

------------------------------------------------------------------------

# 4. Refonte de l'import Excel

## Source d'import

Pour chaque fichier Excel importé :

-   seule la première feuille métier est prise en compte ;
-   aucune donnée non vide ne doit être perdue ;
-   les colonnes non utilisées doivent rester accessibles dans les
    métadonnées d'import ;
-   les autres feuilles ne doivent pas alimenter le CRM.

------------------------------------------------------------------------

# 5. Gestion des cohortes Sxx

## Définition

Les valeurs :

-   S37
-   S39
-   S40
-   S41
-   S42...

correspondent à la semaine/session du premier envoi de prospection.

Elles ne doivent PAS être interprétées comme des semaines ISO.

Chaque cohorte possède une date réelle.

Exemple :

  Cohorte   Date réelle
  --------- -------------------
  S37       7 septembre 2026
  S39       28 septembre 2026
  S40       5 octobre 2026
  S41       12 octobre 2026

Une semaine peut être volontairement absente.

Exemple : - S38 inexistante car aucune prospection n'a été réalisée.

------------------------------------------------------------------------

# 6. Validation humaine du prospect

## Prospect avec Sxx

Un prospect possédant un Sxx est considéré comme :

-   validé humainement ;
-   fonction vérifiée dans l'entreprise ;
-   intégré dans le pipeline de prospection.

Cette validation concerne le poste du prospect, PAS son email.

------------------------------------------------------------------------

## S0

S0 est une cohorte spéciale.

Signification :

-   prospect validé ;
-   personne identifiée ;
-   mais volontairement exclu de la prospection.

Cas : - déjà en projet avec Circoe ; - pas intéressé actuellement.

S0 : - reste dans la base ; - n'est pas contacté ; - n'est pas
défaillant.

Pour le reprendre : - un humain change son Sxx ; - une nouvelle séquence
démarre.

------------------------------------------------------------------------

## Absence de Sxx

Pour les fichiers Excel ayant déjà été vérifiés humainement avant import
:

absence de Sxx = Défaillant.

Défaillant signifie : - contact à éliminer ; - exclusion des séquences
; - conservation dans la base.

------------------------------------------------------------------------

# 7. Séparation des états

Il faut absolument séparer :

## Validation métier

Le prospect est-il validé dans son entreprise ?

Réponse : - Sxx valide ; - S0 valide mais hors campagne.

------------------------------------------------------------------------

## Etat commercial

Exemples : - Contact - R1 - R2 - R3 - Relance terminée - Défaillant

------------------------------------------------------------------------

## Alertes qualité

Exemples : - Erreur sur le mail - Fonction à vérifier - Donnée
incohérente - Entreprise à vérifier

Une alerte ne change jamais automatiquement l'état commercial.

------------------------------------------------------------------------

# 8. Gestion des emails

Un email ne peut jamais être considéré comme valide à 100%.

Un prospect peut : - garder sa fonction ; - changer d'adresse email.

Donc :

Validation fonction ≠ validation email.

------------------------------------------------------------------------

# 9. Erreur sur le mail

Lorsqu'un email revient en erreur :

Le prospect :

-   garde son Sxx ;
-   garde son historique ;
-   sort des séquences automatiques ;
-   apparaît dans une catégorie "Erreur sur le mail".

Il ne devient PAS : - Défaillant ; - supprimé ; - invalidé.

------------------------------------------------------------------------

## Retrouver un nouvel email

Lorsqu'une nouvelle adresse est trouvée :

L'humain :

1.  renseigne le nouvel email ;
2.  change le Sxx ;
3.  place le prospect dans une nouvelle séquence.

Conséquence :

-   compteur de relance remis à zéro ;
-   historique précédent conservé.

------------------------------------------------------------------------

# 10. Système de relance

Ne pas créer des statuts fixes R1/R2/R3 en base.

Le système doit fonctionner avec :

-   cohorte active ;
-   historique des emails réellement envoyés ;
-   compteur de relances effectuées.

------------------------------------------------------------------------

## Affichage

La fiche prospect affiche :

-   Contact
-   R1
-   R2
-   R3
-   R4 ...

------------------------------------------------------------------------

## Règle fondamentale

Le compteur avance uniquement lorsqu'un email a réellement été envoyé.

Une relance prévue mais non envoyée : - ne fait pas avancer le compteur
; - reste en attente.

------------------------------------------------------------------------

# 11. Planning hebdomadaire

Chaque semaine active :

-   nouveaux prospects contactés ;
-   prospects actifs relancés.

Exemple :

  Cohorte   Niveau attendu
  --------- ----------------
  S37       R4
  S39       R3
  S40       R2
  S41       R1

Le dashboard doit afficher :

-   nouveaux contacts à envoyer ;
-   R1 à envoyer ;
-   R2 à envoyer ;
-   R3 à envoyer ;
-   répartition globale par niveau.

------------------------------------------------------------------------

# 12. Relance terminée

Relance terminée ≠ Défaillant.

Un prospect en relance terminée :

-   reste dans la base ;
-   reste consultable ;
-   reste contactable ;
-   conserve son historique.

Il est simplement sorti des actions automatiques.

Pour le reprendre : - l'humain modifie son Sxx.

------------------------------------------------------------------------

# 13. Défaillant

Défaillant est une décision humaine.

Ce statut signifie :

-   contact à éliminer ;
-   exclusion du pipeline actif.

L'IA ne peut jamais mettre automatiquement un prospect en Défaillant.

------------------------------------------------------------------------

# 14. Alertes IA

L'IA peut détecter :

-   fonction potentiellement obsolète ;
-   incohérence entreprise/contact ;
-   email problématique ;
-   données manquantes.

Mais elle ne peut jamais :

-   changer un Sxx ;
-   modifier une validation ;
-   arrêter une campagne ;
-   passer en Défaillant.

------------------------------------------------------------------------

# 15. Champs manquants

Ne jamais inventer une donnée.

Affichage :

-   Fonction vide → "À vérifier"
-   Email absent → "À vérifier"
-   Téléphone absent sans autre canal → "À vérifier"

La valeur réelle reste vide en base.

------------------------------------------------------------------------

# 16. Données entreprise

Les données entreprise ne doivent jamais être écrasées automatiquement.

Règles :

-   champ VIPER vide + Excel rempli → compléter ;
-   même valeur → ignorer ;
-   valeur différente → créer une alerte conflit.

------------------------------------------------------------------------

# 17. Mode de contact

La colonne "Mode de contact" Excel n'est pas pertinente.

Elle ne doit pas : - influencer l'import ; - influencer les séquences
; - apparaître dans l'interface.

Elle peut uniquement rester dans les métadonnées brutes.

------------------------------------------------------------------------

# 18. Migration BASE CLIENT.xlsx

Lors de la première migration :

-   S37/S39/S40/S41 → intégration séquences ;
-   S0 → validé hors campagne ;
-   autres lignes → Défaillant selon validation humaine préalable.

------------------------------------------------------------------------

# 19. Critères d'acceptation

La tâche est terminée lorsque :

-   import Excel sans perte ;
-   cohorte Sxx correctement gérée ;
-   S0 fonctionnel ;
-   Défaillant uniquement selon règle métier ;
-   erreur mail séparée ;
-   historique conservé ;
-   changement de Sxx crée une nouvelle séquence ;
-   relances calculées depuis les envois réels ;
-   dashboard hebdomadaire fonctionnel ;
-   corrections humaines protégées lors des réimports.

------------------------------------------------------------------------

# 20. Ordre recommandé d'implémentation

1.  Analyse modèle de données existant.
2.  Adaptation schéma / migrations.
3.  Refonte import Excel.
4.  Gestion cohortes Sxx.
5.  Gestion historique emails.
6.  Calcul relances.
7.  Gestion exceptions.
8.  Interface fiche prospect.
9.  Dashboard.
10. Tests sur BASE CLIENT.xlsx.
