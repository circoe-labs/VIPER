# 03 — Stratégie d’implémentation

## Phase A — Stabiliser le contrat avant l’UI

1. Introduire les enums/constantes partagées.
2. Migrer `contact_tracking` vers la nouvelle sémantique.
3. Reconciler les anciens statuts sans perte d’historique.
4. Créer les services backend pour les mutations humaines.

Cette phase doit être terminée avant de modifier lourdement l’interface. Le principal risque est de changer les labels sans corriger la sémantique persistée.

## Phase B — Prospection

1. Ajouter les badges état + prochaine semaine sur chaque carte.
2. Supprimer `Inconnu` comme état de pipeline visible.
3. Permettre à l’humain de fixer/modifier la semaine de prochaine échéance.
4. Simplifier les compteurs Prospection sans inventer une formule de complétude non actée.

## Phase C — Contact sans IA

1. Renommer/navigation `Exploitation` → `Contact`.
2. Construire la liste, les filtres et les compteurs actés.
3. Construire le split pane prospect / mail.
4. Ajouter les trois emplacements Contact/R1/R2 avec stockage local en base.
5. Mettre en place le cycle Brouillon/Validé/Programmé/Envoyé/Annulé.

À la fin de cette phase, l’utilisateur doit pouvoir préparer manuellement les trois messages sans aucun appel IA ni envoi réel.

## Phase D — Génération IA

1. Ajouter un adaptateur OpenAI serveur configurable.
2. Construire un prompt strict à partir de données disponibles.
3. Exposer `generate` / `regenerate` pour un message.
4. Garantir qu’une génération ne change jamais l’état prospect et ne valide jamais un message.

## Phase E — Toolbox et envoi

1. Résoudre le flux d’authentification MCP depuis VIPER.
2. Créer le brouillon Infomaniak au moment de la validation ou juste avant programmation.
3. Stocker l’identifiant distant.
4. Implémenter l’envoi différé idempotent dans VIPER.
5. Gérer annulation et suppression du brouillon distant si nécessaire.

## Phase F — Hardening

1. Tests unitaires de règles métier.
2. Tests d’intégration API.
3. Tests de migration sur copie synthétique.
4. Tests UI des états/badges/filtres.
5. Vérification anti-double-envoi.
6. Documentation et rapport final.

## Déploiement incrémental recommandé

Le lot peut être livré en trois jalons activables indépendamment :

- **Jalon 1** : statuts + semaines + Prospection ;
- **Jalon 2** : page Contact + brouillons locaux + IA ;
- **Jalon 3** : Toolbox + programmation différée.

La page Contact peut être cachée derrière un feature flag tant que le dispatch réel n’est pas prêt, mais les migrations doivent être compatibles dès le Jalon 1.
