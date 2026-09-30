# Portage Contact vers la pile `backend/` + `frontend/`

Handoff local (origine : demande Humaine du 2026-09-30, aucune file Drive).

## Mission

Le lot Contact (`tasks/viper_contact_pipeline_handoff/`, Tasks 00-17) a été implémenté dans l'application Node/SQLite
à la racine (`src/`, `tests/`). L'application réellement utilisée est la pile **FastAPI + PostgreSQL (`backend/`) et
React (`frontend/`)**. Le visuel de `src/` est rejeté : il casse la DA.

Objectif : apporter **les fonctionnalités** du lot Contact dans `backend/` + `frontend/`, en gardant **strictement la
DA existante** du frontend (Neon Command : `doc/design/design-system.md`, `frontend/src/theme/tokens.css`,
primitives `frontend/src/ui/`). Rien du CSS ou de la mise en page de `src/client/` ne doit être repris.

## Sources

- Décisions produit (source de vérité) : `tasks/viper_contact_pipeline_handoff/docs/01-decision-log.md`.
- Spécifications : `tasks/viper_contact_pipeline_handoff/docs/02`…`08`, `references/`, `tasks/*/TASK.md`.
- Implémentation de référence (comportement, règles, cas limites, tests) : `src/shared/contactWorkflow.ts`,
  `src/server/contact*.ts`, `src/server/toolbox*.ts`, `src/server/openaiMailGenerator.ts`,
  `src/server/mailGenerationPrompt.ts`, `tests/*.test.ts`, `tasks/viper_contact_pipeline_handoff/FINAL_REPORT.md`.
  C'est une **spécification exécutable**, pas du code à copier : traduire vers les conventions Python/React du dépôt.
- Conventions cibles : `doc/process/runbook-local-dev.md`, `doc/process/testing-strategy.md`, `doc/adr/`,
  `doc/design/design-system.md`.

## Décisions de portage (orchestrateur, 2026-09-30)

- **P1 — Semaine de prochaine échéance** : on garde `contact_tracking.planned_contact_at` comme unique donnée
  « prochaine échéance ». La semaine ISO affichée (`Sxx`) reste dérivée (`iso_week`). Le planificateur de semaine et la
  cadence écrivent le **lundi** de la semaine choisie (minuit heure métier). Pas de colonnes `next_action_year/week`.
  Cela respecte les décisions 5 et 14 (semaine ≠ état ; semaine ≠ `scheduled_at` des messages).
- **P2 — Taxonomie** : 8 états (décision 6). Code stocké `neutral` pour « aucun état » (aucun badge). Migration Alembic
  des données selon `docs/06-data-model.md` §2 du handoff (`to_contact`→`neutral`, `follow_up_1`→`r1`,
  `follow_up_2`→`r2`, `quote_sent`/`quote_follow_up`/`won`→`appointment_obtained`, `not_interested`→`ignored` si
  `do_not_contact` sinon `failure`), historique jamais réécrit (ligne d'historique ajoutée, acteur `system`).
- **P3 — Accueil** : adapté aux nouveaux états, sans refonte. Le groupe « Suivi commercial léger »
  (devis/gagné/pas intéressé) disparaît (post-RDV hors périmètre V1).
- **P4 — Exploitation** devient **Contact** (`/contact`, `/exploitation` redirige).
- **P5 — Envoi programmé** : worker de fond dans le process API (désactivé par défaut) + commande CLI `--once`.
- **P6 — Intégrations** : aucun appel réel à OpenAI, Toolbox ou Infomaniak pendant le développement : faux serveurs
  locaux uniquement. Tout est désactivé par défaut tant que non configuré.

## Règles pour tous les agents

- Branche `task/contact-port`. Commits préfixés par l'ID de Slice : `S1 feat(contact): …`, message en français,
  terminé par `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- Ne jamais toucher la base de développement `viper` ni ses données : tests sur `viper_test` / `viper_e2e` uniquement.
  Ne jamais exécuter `alembic upgrade` sans `-x db=test`.
- Ne pas arrêter les serveurs de l'utilisateur (Vite 5173, API 8042). Les e2e utilisent 8044/5180.
- Ne pas modifier `src/`, `tests/` (racine) ni le handoff d'origine.
- Aucune donnée privée réelle dans le code, les tests ou les commits.
- Charger `/coding-guideline` et `/error-handling` avant de coder ; les primitives `frontend/src/ui/` et les tokens
  avant d'écrire du CSS (aucune couleur en dur hors `tokens.css`).
- Mettre à jour la doc concernée (`doc/features/*`, `doc/architecture/*`, `doc/design/design-system.md`,
  `doc/product/decision-log.md`) dans la même Slice.
- Gate de fin de Slice : `backend/.venv/Scripts/python.exe scripts/verify.py` vert (Playwright `--e2e` pour les Slices UI).
