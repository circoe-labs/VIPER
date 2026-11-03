# Slice 03 — Actions de mission MCP

Tier QA : **critical**. Dépend de la Slice 01 (garde de capacités). Références : HANDOFF §4, §8.4, §13 et §15.

## Outils

| Outil | Service | Capacité | Annotations |
|---|---|---|---|
| `viper_create_mission` (`run_now` optionnel) | `missions.create` (+ `run_mission`) | `missions.write` (+ `missions.run`) | non destructif |
| `viper_update_mission` | `missions.update` | `missions.write` | non destructif |
| `viper_run_mission` | `missions.run_mission` | `missions.run` | non destructif |
| `viper_set_mission_status`, pause ou reprise | `missions.set_status` | `missions.pause` | non destructif |
| `viper_set_mission_status` (annulation), `viper_delete_mission` | `set_status` / `delete` | `missions.cancel` | `destructiveHint: true` |
| `viper_mission_options` | `missions.options`, `agents`, `target_options` | `missions.read` | lecture |

## Règles

- Le schéma d'entrée reprend `MissionInput` / `MissionIn` (`routes/missions.py`). Ne pas dupliquer la
  validation : passer par les services.
- L'acteur enregistré dans l'audit est l'agent agissant pour l'utilisateur délégué (Slice 01).
- Aucun outil `create_task`.
- Modification d'une mission : garder le comportement actuel, où les runs suivants suivent la nouvelle règle.
  Vérifier par un test qu'une tâche déjà créée garde son payload après `update`. N'ajouter un snapshot par run
  que si ce test échoue.

## Validation

Tests :
- création par un agent interactif ;
- refus pour un worker ;
- annulation refusée à un `member` et acceptée pour un `manager` ;
- `update` sans effet sur les tâches existantes.

Plus une trace MCP réelle, une QA adversariale et jusqu'à 10 mutations sur la garde.
