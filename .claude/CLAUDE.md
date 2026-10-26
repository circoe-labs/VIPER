# Instructions projet VIPER

## Workflow Git sur le PC de Lucie (hostname `LUCIE-PC`)

Ces règles s'appliquent uniquement lorsque la session tourne sur `LUCIE-PC` (vérifier avec `hostname`).

- **Branche par défaut : `lucie`.** Toujours travailler sur `lucie`, sauf si un changement de branche est explicitement demandé.
- **`lucie` dérive de `main`** et doit rester le plus à jour possible avec elle.
- **Avant toute implémentation**, mettre `lucie` à jour depuis `main` :
  ```sh
  git checkout lucie
  git fetch origin
  git pull origin main
  ```
  En cas de conflit, le résoudre (ou le signaler) avant de commencer le travail.
- **Quand une tâche est terminée**, pousser `lucie` et ouvrir une Pull Request de `lucie` vers `main` :
  ```sh
  git push -u origin lucie
  gh pr create --base main --head lucie
  ```
