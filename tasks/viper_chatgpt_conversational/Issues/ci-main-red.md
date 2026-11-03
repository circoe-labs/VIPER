# La CI de `main` échouait avant cette tâche

Constaté le 2026-11-03 sur `main@699ec3b` et sur la PR #12 :

- backend : 8 erreurs `ruff` E501 (`app/services/contact_dashboard.py`, `tests/test_contact_dashboard.py`) et 10
  fichiers non formatés ;
- frontend : 2 erreurs ESLint (`no-unnecessary-type-conversion`, `no-unnecessary-type-assertion`) ;
- e2e : 24 violations d'accessibilité en thème sombre (contraste), sur toutes les pages.

Ces échecs n'ont pas de lien avec cette tâche. Ils sont à corriger dans une tâche dédiée.
