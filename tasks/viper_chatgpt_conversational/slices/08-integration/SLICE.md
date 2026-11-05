# Slice 08 — Intégration et validation finale

Tier : **release**. Références : HANDOFF §17 (Slice 08), §19 et §20.

- **Réconciliation** : aligner les noms d'outils, les capacités et le skill.
- **Suites de tests** : backend et frontend complètes, e2e, et un test de migration depuis le `main` d'avant la
  Slice 01.
- **Scénarios à jouer** :
  - création d'une mission par ChatGPT, avec une trace MCP réelle via OAuth ;
  - compatibilité worker (claim, submit, release) ;
  - refus d'une action non autorisée à un worker ;
  - découverte d'un entrepôt, revue puis appliquée ;
  - lectures de contact et brouillons ;
  - attribution d'audit et annotations destructives.
- **CI** : celle de `main` échoue déjà sur le lint et sur l'accessibilité e2e en thème sombre (voir `Issues/`).
  Cette tâche ne doit pas ajouter de nouvel échec.
