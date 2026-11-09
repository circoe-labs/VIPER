# Revue ergonomique — audit initial

Référence examinée : handoff consolidé du 5 novembre 2026. Audit du dépôt `main` à `451524c`,
avec des modifications locales existantes sur les entrepôts et leur icône, à préserver.

## État et contrats existants

- Prospection possède déjà `validated_only` et une liste commune ; `/contacts-joignables` est
  encore une page séparée, avec un regroupement par société et des outils de prestations. Les
  liens historiques et ces fonctionnalités doivent être conservés lors de l'intégration.
- La validation de l'emploi et celle du courriel sont distinctes. L'aperçu backend répartit la
  base entre emploi validé, validation non enregistrée et ignorés. Vérification utilise aussi
  des alertes ouvertes « Fonction à vérifier » pour ses incertitudes ; son chargement actuel
  est limité à 200 alertes et ne constitue pas encore un décompte complet garanti.
- Partition proposée pour la base entière, chaque personne une fois : ignorée si son état est
  ignoré ; sinon validée si son emploi a une date de validation ; sinon incertaine si elle a au
  moins une alerte ouverte « Fonction à vérifier » ; sinon à vérifier. Une alerte en double ne
  doit pas compter deux fois. Les états de validation du courriel et la date de création ne
  modifient pas cette partition. Les compteurs et les filtres doivent partager ces mêmes règles.
- Dans Contact, les dates sous le graphique sont des repères indépendants, stockés dans les
  paramètres ; elles ne modifient ni les envois réels ni les prochaines échéances. Les dates
  de planification et les événements réels sont des concepts distincts et doivent le rester.
- La connaissance de Robin est actuellement encodée dans des notes de prospect. Aucun modèle
  de relation générique entre personnes n'a été identifié. Une migration doit définir identité,
  symétrie, doublons et traitement des notes historiques avant toute écriture.
- Les pages Base de données, Organisation, Historique agents, Paramètres et la visualisation du
  graphe restent hors périmètre. Les travaux locaux sur Entrepôts restent en place.

## Décision de préparation

**HUMAN_DECISION_REQUIRED** pour la direction des relations et la migration des connaissances
existantes. L'audit, les corrections d'interface indépendantes et leurs tests peuvent avancer sans
modifier ces données. Les commandes `/caveman`, `/coding-guideline`, `/impeccable` et le routage
Claude mentionnés dans le handoff ne sont pas disponibles dans cette session ; utiliser les
vérifications et outils disponibles, sans les déclarer exécutés.

Contrôles disponibles : `python scripts/verify.py`, tests ciblés pytest/Vitest et Playwright.
Les résultats de validation devront être consignés avec les changements effectivement réalisés.
