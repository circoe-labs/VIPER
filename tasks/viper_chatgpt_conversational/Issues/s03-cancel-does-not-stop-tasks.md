# Annuler ou mettre en pause une mission n'arrête pas les tâches déjà en file

Problème antérieur à la tâche (il touche aussi le PATCH REST), relevé par la Slice 03 le 2026-11-03.
`set_status` ne ferme pas les tâches ouvertes, et `agent_missions.claim` ne vérifie pas le statut de la mission.
Conséquence : une tâche en attente d'une mission annulée reste réclamable par un worker, et le run reste
`running`.

Ce point devient visible avec ChatGPT : un utilisateur annule une mission dans la conversation, mais les workers
continuent. Proposition du PM : une petite Slice 03.1 (« annuler ferme les tâches ouvertes ; claim ignore les
missions en pause ou annulées »), à décider avant la Slice 08.

## Autres suites de la QA de la Slice 03

- **Récurrence sans `missions.run`.** Une mission créée avec `is_recurring` et sans date de début est lancée par
  le planificateur, même si l'agent n'a pas `missions.run`. C'est sans effet avec les profils par défaut, qui ont
  tous les deux `missions.run`. À trancher : la première exécution planifiée doit-elle exiger `missions.run` ?
- **Organisations.** Les missions, les cibles et `agent_id` ne sont pas limités à l'organisation. Même problème
  latent que pour la Slice 01.
