# 08 — Points ouverts / non inventés

Ces points ne doivent pas être transformés silencieusement en décisions produit.

## 1. Formule de complétude de la base

L’utilisateur veut un indicateur moyen de complétude de la base dans Prospection, mais la liste et le poids des champs obligatoires n’ont pas été définis.

**Action :** ne pas inventer une pondération. Laisser le compteur hors du premier lot ou proposer une PR séparée avec formule documentée.

## 2. Compteurs Contact additionnels

Sont verrouillés :

- à traiter cette semaine, avec distinction premier contact / relance ;
- RDV pris cumulés.

Les autres cartes éventuelles ne sont pas figées.

## 3. Adresse d’expéditeur exacte

Une adresse a été citée oralement mais avec orthographe incertaine. Elle doit être configurable.

## 4. Identifiant exact du modèle OpenAI

Le grill fixe l’usage de l’API OpenAI pour la rédaction mais pas un identifiant de modèle API stable. Utiliser une variable `OPENAI_MODEL` et vérifier la documentation officielle au moment de l’implémentation.

## 5. Authentification VIPER → Toolbox MCP

Le Toolbox MCP exige OAuth 2.1 + PKCE. Le mode exact d’intégration dans VIPER doit être validé techniquement : session utilisateur réutilisée, flow de connexion spécifique, ou autre mécanisme officiellement supporté par la Toolbox.

## 6. Pièces jointes

L’utilisateur souhaite une interface proche d’une boîte mail et mentionne les pièces jointes, mais l’audit effectué n’a pas confirmé le contrat d’attachment des outils MCP mail. Ne pas bloquer la V1 Contact dessus.

## 7. Heure par défaut

La semaine est choisie en Prospection. La date/heure exacte est choisie lors de la programmation du mail. Aucune heure par défaut n’a été actée.

## 8. Suppression physique des prospects Ignorés

La décision produit est de conserver un blocage persistant. La suppression physique n’est donc pas requise et serait risquée pour la déduplication / opposition.
