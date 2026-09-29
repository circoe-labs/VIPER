# VIPER — Handoff d’implémentation Contact & cycle de prospection

Ce dossier transforme la session de grill du 29 septembre 2026 en plan d’implémentation autonome pour le dépôt `circoe-labs/VIPER`.

## Point de départ

Le dépôt actuel dispose déjà d’une V1 base de données + interface humaine, d’une page **Prospection** fonctionnelle et d’un placeholder **Exploitation**. La session de grill redéfinit le suivi de contact et remplace ce placeholder par une vraie page **Contact**.

Les décisions de cette session supersèdent les parties incompatibles de l’ancienne source de vérité, notamment :

- disparition de `Inconnu` comme statut métier visible ;
- disparition de `Validé / Non validé` comme statut global d’un prospect ;
- état neutre sans badge avant toute décision de contact ;
- nouveaux états visibles : `Contacté`, `R1`, `R2`, `Réponse reçue`, `RDV pris`, `Failure`, `Ignoré` ;
- badge semaine séparé de l’état ;
- toutes les décisions d’état restent humaines en V1 ;
- relances par défaut à +2 semaines ;
- après R2, une échéance de revue à +4 semaines est proposée, sans passage automatique en `Failure` ;
- la page **Exploitation** devient **Contact** ;
- le seul usage IA métier en V1 est le pré-remplissage des emails `Contact`, `R1`, `R2` ;
- aucune détection automatique des réponses email ou des rendez-vous n’est implémentée dans ce lot.

## Comment utiliser ce handoff

1. Ouvrir `tasks/TODO.md`.
2. Exécuter `tasks/00-orchestrator/TASK.md` en premier.
3. Suivre les tâches dans l’ordre, sauf si l’orchestrateur documente une dépendance réelle justifiant un réordonnancement.
4. Pour toute tâche de code, charger les skills `/caveman` et `/coding-guideline` depuis `~/ai/skills/` avant modification.
5. Mettre à jour `tasks/TODO.md` après chaque tâche et produire un rapport final à partir de `templates/final-implementation-report-template.md`.

## Ressources incluses

- `grill-session.md` : reconstruction fidèle de la session de décisions.
- `references/source-de-verite.md` : cahier des charges antérieur, à utiliser comme contexte et non comme arbitre lorsqu’il contredit la session du 29/09/2026.
- `docs/05-current-repo-audit.md` : état observé du dépôt VIPER avant implémentation.
- `docs/06-data-model.md` : contrat de données cible recommandé.
- `docs/07-tooling-and-integrations.md` : OpenAI + CIRCOE Toolbox.
- `docs/08-open-questions.md` : points volontairement non inventés.

## Dépôts concernés

- VIPER : `https://github.com/circoe-labs/VIPER`
- CIRCOE Toolbox : `https://github.com/circoe-labs/circoe-toolbox`
- Endpoint MCP Toolbox communiqué : `https://circoetoolbox-server-production.up.railway.app/mcp`

Le README actuel de VIPER indique que la branche de travail locale est `GPT` et suit `origin/GPT`. L’orchestrateur doit vérifier la branche active avant toute écriture et ne jamais supposer que `main` est la branche de travail.
