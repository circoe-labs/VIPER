# TODO — Portage Contact vers `backend/` + `frontend/`

Lire `README.md` (mission, sources, décisions P1-P6, règles) avant toute Slice.
Chaque Slice = un agent d'implémentation, puis une revue QA indépendante, puis la vérification de l'orchestrateur.

- [x] **S0 — Baseline** : remettre `scripts/verify.py --e2e` au vert sur la dette préexistante (ruff, mypy, tests
  d'import). Aucun changement fonctionnel.
- [ ] **S1 — Modèle d'états (backend)** : enum 8 états (`neutral`, `contacted`, `r1`, `r2`, `response_received`,
  `appointment_obtained`, `failure`, `ignored`) + labels FR, migration Alembic `0008` (CHECK + remap des données +
  lignes d'historique `system`), helper de cadence (+2/+2/+4 semaines, lundi ISO), service de suivi manuel
  (transitions humaines, `ignored` terminal + renforcement `do_not_contact`, suggestion de prochaine semaine),
  segments/compteurs Prospection, Accueil (P3), import Excel et réconciliation opérationnelle, export, historique.
  Réf. : `src/shared/contactWorkflow.ts`, `src/server/contactTracking*.ts`, handoff Tasks 01-04.
- [ ] **S2 — États et semaines dans l'UI existante** : `TRACKING_STATUSES`/labels, badges d'état (aucun pour neutre)
  et de semaine dans la liste Prospection, `TrackingSection` (sélection d'état, planificateur de semaine, suggestion de
  cadence), compteurs/filtres, Accueil adapté. DA existante uniquement. Réf. : handoff Tasks 05-07.
- [ ] **S3 — Contact backend** : tableau de bord Contact (compteurs « à traiter cette semaine » premier contact /
  relances / revues R2, « RDV pris » cumulé, filtres semaine + état, liste) ; table `contact_messages` (étapes
  Contact/R1/R2, statuts Brouillon/Validé/Programmé/Envoyé/Annulé, révisions, validation individuelle, modification ⇒
  retour Brouillon, Envoyé immuable, annulation des messages futurs sur `response_received`/`appointment_obtained`/
  `ignored`), API REST, audit. Réf. : handoff Tasks 09, 11, 12.
- [ ] **S4 — Page Contact (frontend)** : Exploitation → Contact (P4), primitive `Tabs` dans `src/ui/`, compteurs et
  filtres, liste, fiche prospect à gauche + séquence mail à droite (onglets Contact/R1/R2, éditeur De/À/Cc/Cci/objet/
  corps, actions Enregistrer/Valider/Programmer/Déprogrammer/Annuler/Rouvrir avec confirmations), tests + e2e.
  Réf. : handoff Tasks 08, 10, 13.
- [ ] **S5 — Génération OpenAI** : service backend (prompt versionné, aucune donnée inventée, résultat toujours
  Brouillon), configuration `VIPER_OPENAI_*`, bouton « Générer / Régénérer avec l'IA » + consigne. Faux serveur en test.
  Réf. : handoff Task 14, `src/server/openaiMailGenerator.ts`, `mailGenerationPrompt.ts`.
- [ ] **S6 — CIRCOE Toolbox** : OAuth + client MCP + stockage du jeton hors base, création/mise à jour/suppression de
  brouillons Infomaniak à la validation, section Paramètres « Connexions », désactivé par défaut. Faux Toolbox en test.
  Réf. : handoff Task 15, `src/server/toolbox*.ts`, `references/toolbox-capabilities.md`.
- [ ] **S7 — Envoi programmé + durcissement** : worker (P5) avec verrou idempotent, reprise, limites de retard,
  réconciliation ; CLI `--once` ; scénario e2e complet ; doc, runbook, rapport final. Réf. : handoff Tasks 16-17.

## Journal

- 2026-09-30 : handoff créé par l'orchestrateur ; branche `task/contact-port` depuis `claude` @ `2bd1c3b`.
- 2026-09-30 : S0 accepté (`ad2e266`) — gate `verify.py --e2e` verte : pytest 973, vitest 610, Playwright 95. À noter : l'import convertit une semaine passée en « contacté » (6ebc51b/c3db0cb) ; un prospect « échu » se crée par l'API dans les tests.
