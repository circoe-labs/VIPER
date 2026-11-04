# Slice 03.1 — Annuler ou mettre en pause une mission arrête ses tâches

Tier QA : **critical** (cycle de vie des tâches, persistance). Créée par le PM le 2026-11-04 sur décision de
l'utilisateur. Origine : `Issues/s03-cancel-does-not-stop-tasks.md`.

## Problème

`missions.set_status` ne ferme pas les tâches ouvertes, et `agent_missions.claim` ne vérifie pas le statut de la
mission. Une tâche en attente d'une mission annulée ou en pause reste réclamable, et le run reste `running`. Avec
ChatGPT, l'utilisateur annule dans la conversation mais les workers continuent.

## Comportement attendu

- **Pause** (`paused`) : les tâches restent en file mais **ne sont plus proposées ni réclamables**
  (`viper_task_queue` les masque, `viper_claim_task` les refuse). Une tâche déjà réclamée peut finir (submit,
  release, fail, heartbeat acceptés). La reprise (`active`) les rend de nouveau réclamables. Le planificateur ne
  crée pas de nouveau run pour une mission en pause (vérifier ; c'est peut-être déjà le cas).
- **Annulation** (`cancelled`) : dans la même transaction, toutes les tâches ouvertes de la mission (en attente et
  réclamées) passent à un statut terminal (réutiliser l'existant, `cancelled` s'il existe, sinon le choisir et le
  documenter), et chaque run non terminal passe à `cancelled`. Un worker qui envoie ensuite heartbeat ou submit
  sur une telle tâche reçoit un refus explicite et stable (code d'erreur documenté), pas une 500 ni un succès.
  Rien n'est écrit dans le domaine pour un résultat arrivé après l'annulation.
- **Suppression** (`viper_delete_mission` / REST) : vérifier qu'elle ne laisse pas de tâche réclamable orpheline.
- Le même service sert le REST (`PATCH` mission) et le MCP : corriger dans les services
  (`app/services/missions.py`, `app/services/agent_missions.py`), pas dans les routes.

## Hors périmètre

- La récurrence sans `missions.run` et le cloisonnement par organisation (voir l'Issue d'origine) restent des
  Issues.
- Le frontend : seulement s'il affiche un statut de tâche ou de run qui deviendrait faux ; sinon rien.

## Validation

Tests (`backend/tests/`) :
- annulation → tâches en attente et réclamées terminales, run `cancelled`, claim refusé, submit refusé avec le
  code stable, aucune écriture de domaine ;
- pause → queue vide et claim refusé pour cette mission, tâche déjà réclamée peut soumettre ; reprise → réclamable ;
- même effet via REST et via MCP (`viper_set_mission_status`) ;
- les autres missions ne sont pas touchées.
Documentation : `doc/architecture/mcp-server.md` (§3.10 et la partie worker) et la doc missions si elle décrit le
cycle de vie. Mettre à jour `Issues/s03-cancel-does-not-stop-tasks.md` (résolu pour le premier point).

## Contexte de dispatch

- Branche de base : `feat/chatgpt-conversational`. Migration : aucune attendue ; si nécessaire, `0028` après `0027`.
- Base de test dédiée : `VIPER_TEST_DATABASE_URL=postgresql+psycopg://viper:viper@127.0.0.1:5442/viper_s031_test`.
- Ne pas toucher `backend/app/api/routes/mcp_settings.py` ni `app/services/oauth.py` (Slice 09 en parallèle).
