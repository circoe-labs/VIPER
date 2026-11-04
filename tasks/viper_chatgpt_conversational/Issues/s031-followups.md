# Suites de la Slice 03.1 (2026-11-04)

- **Fil d'agent en pause.** Mettre en pause un fil d'agent (hors missions) n'empêche pas de réclamer ses tâches.
  Même problème que celui corrigé pour les missions, hors périmètre de la Slice 03.1.
- **Mission passée à `done` par le REST.** Ses tâches ouvertes ne sont pas fermées.
- **Choix assumé par le PM.** L'annulation ferme aussi les tâches déjà soumises : un résultat en attente de revue
  est rejeté (`mission_cancelled`) au lieu de rester relisible. Sans cela, le run repassait à `running` et un rejet
  remettait la tâche en file. À revoir si l'on veut garder ce travail relisible.
