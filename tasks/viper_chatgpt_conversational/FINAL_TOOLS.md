# Liste finale des outils MCP de VIPER (Slice 08)

Relevée le 2026-11-04 dans `app.api.mcp.TOOLS`, sur la branche `feat/chatgpt-conversational` après la Slice 08.
Elle sert à mettre à jour le skill `viper-use` côté ChatGPT (Slice 05, livré hors dépôt). Elle est vérifiée par la
trace `e_annotations` et par `tests/test_mcp_*.py`.

**29 outils.** La colonne « Capacité » indique ce que `require` vérifie avant l'appel. Les capacités effectives
d'un agent sont ses capacités propres ∩ celles du rôle de la personne pour qui il agit : un `member` n'a pas
`missions.cancel`.

Annotations : `RO` = `readOnlyHint: true, destructiveHint: false, openWorldHint: false`. `W` = `readOnlyHint:
false, destructiveHint: false, openWorldHint: false`. `D` = `readOnlyHint: false, destructiveHint: true,
openWorldHint: false`. « aucune » : l'outil ne déclare pas d'annotations, donc les valeurs par défaut de MCP
s'appliquent (destructif, monde ouvert ; voir `Issues/s08-integration-followups.md`).

## Identité

| Outil | Capacité | Annotations | Rôle |
|---|---|---|---|
| `viper_whoami` | aucune | RO | Qui est l'agent pour VIPER : mode, fournisseur, personne déléguée et son rôle, capacités effectives, `restriction`. À appeler en premier. |

## Lectures conversationnelles

| Outil | Capacité | Annotations |
|---|---|---|
| `viper_search` | `records.read` | RO |
| `viper_list_companies` | `records.read` | RO |
| `viper_get_company` | `records.read` | RO |
| `viper_list_prospects` | `records.read` | RO |
| `viper_get_prospect` | `records.read` | RO |
| `viper_get_dashboard` | `dashboard.read` | RO |
| `viper_get_prospection_metrics` | `dashboard.read` | RO |
| `viper_list_missions` | `missions.read` | RO |
| `viper_get_mission` | `missions.read` | RO |
| `viper_list_pending_reviews` | `reviews.read` | RO |
| `viper_get_contact_overview` | `contact.read` | RO |
| `viper_get_prospect_messages` | `contact.read` | RO |

## Missions (assistant)

| Outil | Capacité | Annotations | `_meta` (app MCP) |
|---|---|---|---|
| `viper_mission_options` | `missions.read` | RO | `openai/widgetAccessible` |
| `viper_create_mission` | `missions.write`, plus `missions.run` si `run_now` | W | `ui.resourceUri` = `ui://viper/mission-card-v1.html`, `openai/outputTemplate`, `openai/widgetAccessible`, `openai/toolInvocation/*` |
| `viper_update_mission` | `missions.write` (`run_now` refusé) | W | `openai/widgetAccessible` |
| `viper_run_mission` | `missions.run` | W | `openai/widgetAccessible` |
| `viper_set_mission_status` | `paused` / `active` : `missions.pause` ; `cancelled` : `missions.cancel` | **D** (aussi pour pause et reprise) | — |
| `viper_delete_mission` | `missions.cancel` | **D** | — |

## Brouillons de contact

| Outil | Capacité | Annotations |
|---|---|---|
| `viper_generate_contact_draft` | `contact.draft` | W, `idempotentHint: false`, **`openWorldHint: true`** (appelle le modèle OpenAI configuré) |
| `viper_update_contact_draft` | `contact.draft` | W, `idempotentHint: false` |

Un agent ne crée ou ne modifie qu'un message `draft`. Sur un message `validated`, `scheduled` ou `cancelled`, la
réponse est `agent_draft_only` ; sur un message `sent`, `message_sent_immutable`. La validation, la programmation et
l'envoi ne sont pas exposés.

## Worker (tâches de mission)

| Outil | Capacité | Annotations |
|---|---|---|
| `viper_task_queue` | `tasks.work` | aucune |
| `viper_claim_task` | `tasks.work` | aucune |
| `viper_heartbeat_task` | `tasks.work` | aucune |
| `viper_submit_task_result` | `tasks.work` | aucune |
| `viper_release_task` | `tasks.work` | aucune |
| `viper_fail_task` | `tasks.work` | aucune |
| `viper_update_company` | `records.propose` (et la portée de types de tâche du jeton) | aucune |
| `viper_update_prospect` | `records.propose` (idem) | aucune |

La découverte de sites n'est pas un outil. Une entreprise d'un résultat `find_prospects` peut porter
`establishments` (nom, type, SIRET, adresse, `opened_on`, `surface_m2`, `source`) et un `trigger` daté (`kind` :
`facility_opening`, `facility_expansion`, `construction` ou `relocation`, plus `source` et `observed_on`). Le payload
annonce `output_schema_version: 2`.

## Ressources (MCP Apps)

`resources/list` et `resources/read` exposent `ui://viper/mission-card-v1.html` (`text/html;profile=mcp-app`).
Aucune capacité n'est requise, mais un jeton valide l'est.

## Capacités par défaut selon le mode

- `worker` : `tasks.work`, `records.read`, `records.propose`.
- `scheduled` : les capacités de `worker`, plus `dashboard.read`, `missions.read`, `reviews.read` et `contact.read`.
- `interactive` (connecteur OAuth) : les 12 capacités, réduites ensuite par le rôle. Un `member` a tout sauf
  `missions.cancel`.

## Écarts avec le skill `viper-use` livré (`Downloads/viper-use`, Slice 05)

Les 27 noms d'outils que cite le skill existent tous. Rien n'est renommé ni retiré. À mettre à jour dans le skill :

1. **Lectures oubliées** : `viper_list_companies` et `viper_list_prospects`, pour une liste paginée par nom ou par
   employeur. `viper_search` reste le point d'entrée.
2. **Pause et reprise** : `viper_set_mission_status` est annoté destructif même pour une pause. ChatGPT peut donc
   demander une confirmation. Le skill devrait le dire sans exiger de « oui » pour une pause ou une reprise : seules
   l'annulation et la suppression demandent une confirmation explicite.
3. **Refus attendus** : `capability_denied` contient le champ `capability` (par exemple `missions.cancel` pour un
   `member`). Le contact renvoie `agent_draft_only`, `message_sent_immutable`, `revision_conflict`,
   `message_exists` ou `replace_confirmation_required`. Le skill doit les expliquer sans les contourner.
4. **Mode worker** : pour une mission de découverte (`find_prospects`), renseigner `establishments` et `trigger` avec
   une source http(s). Un déclencheur futur ou plus ancien que `period_days` est refusé seul (`future`, `too_old`).
   Le nombre d'entreprises est limité par `result_limit`. Ces deux contrôles lisent la règle du run, pas la mission
   modifiée ensuite.
5. **Outils sans annotations** : les outils worker n'ont pas d'annotations. En mode interactif, ChatGPT peut demander
   une confirmation pour `viper_claim_task` ou `viper_submit_task_result`. Le skill ne peut pas l'empêcher.
6. **Carte de mission** : après `viper_create_mission`, ChatGPT peut afficher la carte, avec « Lancer maintenant »
   et « Modifier les paramètres ». Le skill n'a pas à décrire la mission une seconde fois.
