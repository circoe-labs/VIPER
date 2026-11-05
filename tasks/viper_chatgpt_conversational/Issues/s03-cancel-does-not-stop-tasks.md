# Annuler ou mettre en pause une mission n'arrête pas les tâches déjà en file

Problème antérieur à la tâche (il touche aussi le PATCH REST), relevé par la Slice 03 le 2026-11-03.
`set_status` ne ferme pas les tâches ouvertes, et `agent_missions.claim` ne vérifie pas le statut de la mission.
Conséquence : une tâche en attente d'une mission annulée reste réclamable par un worker, et le run reste
`running`.

**Résolu par la Slice 03.1 (2026-11-04).** `missions.set_status` annule désormais, dans la même
transaction, les tâches ouvertes (en attente, réclamées, soumises → `cancelled`, résultat en attente
de revue rejeté) et les runs non terminaux (→ `cancelled`) ; une mission en pause n'est plus proposée
(`viper_task_queue`, `viper_claim_task`) mais une tâche déjà réclamée peut finir. Un worker qui
continue reçoit le refus stable `task_cancelled`. Les deux points ci-dessous restent ouverts.

Ce point devient visible avec ChatGPT : un utilisateur annule une mission dans la conversation, mais les workers
continuent. Proposition du PM : une petite Slice 03.1 (« annuler ferme les tâches ouvertes ; claim ignore les
missions en pause ou annulées »), à décider avant la Slice 08.

## Autres suites de la QA de la Slice 03

- **Récurrence sans `missions.run`.** Une mission créée avec `is_recurring` et sans date de début est lancée par
  le planificateur, même si l'agent n'a pas `missions.run`. C'est sans effet avec les profils par défaut, qui ont
  tous les deux `missions.run`. À trancher : la première exécution planifiée doit-elle exiger `missions.run` ?
- **Organisations.** Les missions, les cibles et `agent_id` ne sont pas limités à l'organisation. Même problème
  latent que pour la Slice 01.
