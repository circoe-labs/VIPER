# Slice 08 — suites relevées pendant l'intégration (2026-11-04)

## Outils sans annotations

Les six outils de tâche (`viper_claim_task`, `viper_heartbeat_task`, `viper_submit_task_result`,
`viper_fail_task`, `viper_release_task`, `viper_task_queue`) et `viper_update_company` /
`viper_update_prospect` n'ont pas d'`annotations`. Ils existaient avant la tâche et n'en ont jamais eu.

Les valeurs par défaut du protocole MCP s'appliquent donc : `readOnlyHint: false`,
`destructiveHint: true`, `openWorldHint: true`. Un hôte comme ChatGPT peut alors demander une
confirmation pour un claim ou un submit. Les outils explicitement marqués destructifs restent exactement
`viper_set_mission_status` et `viper_delete_mission`.

Proposition : déclarer `viper_task_queue` en lecture seule et les autres outils comme écritures non
destructives (`destructiveHint: false`, `openWorldHint: false`). C'est un changement de comportement
côté hôte ; il n'a pas été fait en Slice 08.

## Les e2e ne passent plus depuis la PR #12

Ce problème existait sur `main@0339153` avant cette tâche. Il dépasse l'issue `ci-main-red.md`, qui ne parlait que du
contraste en thème sombre.

- **Domaine de connexion.** Le compte E2E `pilote.e2e@example.com` est refusé par `VIPER_SIGNIN_EMAIL_DOMAINS`
  (valeur par défaut : `circoe.com`). Avec la configuration de la CI, 105 tests échouent dès la connexion. Le
  compte a été relevé sur la branche, mais le réglage en cause vient de `main` (`e955197`).
  Contournement local utilisé en Slice 08 : `VIPER_SIGNIN_EMAIL_DOMAINS=circoe.com,example.com`. Il faut
  l'ajouter à l'environnement du backend dans `playwright.config.ts`.
- **Specs périmées.** Même avec le contournement, `main` donne 55 échecs, 54 réussites et 9 tests non lancés :
  - accessibilité en thèmes clair et sombre (16) ;
  - navigation principale qui a gagné des liens (`shell.spec`) ;
  - Paramètres réorganisés (`settings.spec`) ;
  - écrans d'accueil, de prospection, de l'éditeur, de contact et d'import.

  La branche donne 54 échecs, 55 réussites et 9 non lancés. Ses échecs sont un sous-ensemble strict de ceux de
  `main` : seul `design.spec.ts:37` échoue sur `main` et passe sur la branche.

## Taille de `viper_get_contact_overview`

C'est le point de polish de la Slice 02. La trace S08 (d) mesure 8,7 Ko de réponse sur une base de test qui ne
contient qu'un prospect. Une vraie semaine renvoie les listes complètes de la planification. Il faut mesurer sur
la base réelle, puis paginer ou limiter les listes si ChatGPT tronque ou ralentit.

## `mypy` local

`mypy` remonte 12 erreurs, identiques sur `main` et sur la branche (migrations 0020 et 0023, tests `test_auth`,
`test_cli`, `test_audit`, `test_agenda`, `test_oauth`, `test_missions`). La CI les signale peut-être aussi : ce
n'est pas vérifié.
