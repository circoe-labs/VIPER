# TODO — Portage Contact vers `backend/` + `frontend/`

Lire `README.md` (mission, sources, décisions P1-P6, règles) avant toute Slice.
Chaque Slice = un agent d'implémentation, puis une revue QA indépendante, puis la vérification de l'orchestrateur.

- [x] **S0 — Baseline** : remettre `scripts/verify.py --e2e` au vert sur la dette préexistante (ruff, mypy, tests
  d'import). Aucun changement fonctionnel.
- [x] **S1 — Modèle d'états (backend)** : enum 8 états (`neutral`, `contacted`, `r1`, `r2`, `response_received`,
  `appointment_obtained`, `failure`, `ignored`) + labels FR, migration Alembic `0008` (CHECK + remap des données +
  lignes d'historique `system`), helper de cadence (+2/+2/+4 semaines, lundi ISO), service de suivi manuel
  (transitions humaines, `ignored` terminal + renforcement `do_not_contact`, suggestion de prochaine semaine),
  segments/compteurs Prospection, Accueil (P3), import Excel et réconciliation opérationnelle, export, historique.
  Réf. : `src/shared/contactWorkflow.ts`, `src/server/contactTracking*.ts`, handoff Tasks 01-04.
- [x] **S2 — États et semaines dans l'UI existante** : `TRACKING_STATUSES`/labels, badges d'état (aucun pour neutre)
  et de semaine dans la liste Prospection, `TrackingSection` (sélection d'état, planificateur de semaine, suggestion de
  cadence), compteurs/filtres, Accueil adapté. DA existante uniquement. Réf. : handoff Tasks 05-07.
- [x] **S3 — Contact backend** : tableau de bord Contact (compteurs « à traiter cette semaine » premier contact /
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
- 2026-09-30 : S1 accepté (`137ab12`, `6d5d35c`, correctifs QA `907ac5a`) — pytest 1027. QA : 4 mineurs corrigés (ancre « Depuis le » hors migration, Explorer ne peut plus lever `ignored`, PATCH garde une semaine explicite, compteur `do_not_contact` non ignoré). Décision **P7** : la règle d'import « semaine passée → contacté » ne lit que la semaine du fichier, pose la prochaine échéance à semaine + 2 et ne retire jamais un référent saisi à la main.
- 2026-09-30 : S2 accepté (`a44f7ba`, `fb9809b`, correctifs QA `d7d0694`) — DA vérifiée sur captures ; filtre « Aucun état » = `neutral` ou sans suivi ; « Échu » d'affichage aussi pour Contacté/R1/R2. **Question Humaine ouverte** : handoff Task 07 (réduire les compteurs Prospection à ≤ 6 cartes) non fait — change une page acceptée.
- 2026-09-30 : S3 accepté (`8ee74e5`, correctifs QA `03014bd`) — l'opposition (`do_not_contact`) annule aussi les messages non envoyés ; réponses `cancelled_messages` / `in_flight_messages` ; « RDV pris » n'exclut que `ignored`. Reste-à-faire S6/S7 listé dans `doc/features/contact.md`.
- 2026-09-30 : gate orchestrateur après S2+S3 : pytest 1121, vitest 633, Playwright 95 — verts. Machine à mémoire saturée : lancer vitest avec `--maxWorkers=3` et Playwright avec `--workers=3`, et **ne jamais lancer deux gates en parallèle** (base `viper_test` partagée).
- 2026-09-30 : **Décision Humaine** — pas de limite au nombre de cartes-compteurs de Prospection : le point « ≤ 6 cartes » de la Task 07 du handoff est abandonné. Les 16 compteurs actuels restent.
