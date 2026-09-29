# 00 — Vue d’ensemble

## Objectif

Transformer VIPER d’une V1 « base de données + Prospection + placeholder Exploitation » en une V1 capable de **planifier et préparer humainement une séquence de contact** sans automatiser la décision commerciale.

Le lot cible deux capacités prioritaires :

1. un modèle clair d’état + prochaine semaine sur chaque prospect ;
2. une vraie page **Contact** pour préparer, valider, programmer et consulter les emails `Contact`, `R1`, `R2`.

## Modèle mental

VIPER sépare désormais trois choses :

- **donnée prospect** : qui est la personne, dans quelle entreprise, quelles coordonnées sont disponibles ;
- **état de séquence** : dernière étape / situation actuelle (`Contacté`, `R1`, `R2`, etc.) ;
- **prochaine échéance** : semaine métier indépendante de l’état.

Une quatrième dimension apparaît pour les emails : leur propre cycle `Brouillon → Validé → Programmé → Envoyé / Annulé`.

## Périmètre inclus

- état neutre sans badge ;
- badges d’état et de semaine visibles partout ;
- changement manuel des états ;
- planification manuelle de la semaine de prochaine échéance ;
- page Contact et filtres par semaine / état ;
- dashboard Contact minimal avec métriques actées ;
- vue split prospect à gauche / email à droite ;
- onglets Contact, R1, R2 ;
- génération IA de l’objet et du contenu ;
- régénération guidée par l’utilisateur ;
- validation manuelle de chaque email ;
- programmation date/heure ;
- envoi via CIRCOE Toolbox ;
- annulation mécanique des futurs emails après une décision humaine incompatible avec la poursuite de la séquence ;
- journalisation/audit des décisions et envois.

## Non-objectifs de ce lot

- lire automatiquement les réponses de la boîte mail ;
- détecter automatiquement Calendly ;
- classifier automatiquement une réponse ;
- modifier automatiquement le statut d’un prospect en fonction d’un email reçu ou envoyé ;
- gérer devis, commande, CRM post-rendez-vous ;
- faire de l’IA un décideur du workflow ;
- implémenter IProspect ;
- enrichir automatiquement les données prospect ;
- imposer une formule de complétude de base non actée pendant le grill.

## Priorité d’implémentation

1. contrat d’état et migration des données ;
2. badges + semaines dans Prospection ;
3. page Contact et filtres ;
4. modèle de messages Contact/R1/R2 ;
5. génération IA ;
6. validation / programmation ;
7. Toolbox mail ;
8. dispatch différé robuste ;
9. tests et documentation.
