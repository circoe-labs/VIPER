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
