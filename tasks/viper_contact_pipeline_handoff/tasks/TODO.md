# TODO — VIPER Contact & cycle de prospection

## Mission

Implémenter le nouveau cycle de contact humain dans `circoe-labs/VIPER`, en commençant par les états/badges/semaines puis la page Contact, la génération IA et enfin l’envoi différé via CIRCOE Toolbox.

## Règles de travail

- Commencer obligatoirement par `00-orchestrator`.
- Pour **toute tâche de code**, charger `/caveman` et `/coding-guideline` depuis `~/ai/skills/`.
- Vérifier la branche Git avant toute modification. Le README actuel mentionne la branche `GPT` suivant `origin/GPT`.
- Ne jamais committer de données privées réelles.
- Ne pas inventer de décision produit absente de `docs/01-decision-log.md`.
- Si une tâche révèle une dépendance ou une erreur dans ce plan, l’orchestrateur doit mettre à jour les TASK.md concernés et ce TODO avant de continuer.
- Une tâche n’est terminée que lorsque ses critères d’acceptation et tests sont satisfaits ou explicitement documentés comme bloqués.
- Toute évolution d’état prospect doit rester **humaine** en V1.
- L’IA ne fait que générer du texte.

## Ordre des tâches

- [x] 00 — Orchestrator
- [x] 01 — Contrat de workflow partagé
  - `src/shared/contactWorkflow.ts` (états, labels, étapes, semaines ISO, cadence +2/+2/+4 ; Zod) + `tests/contactWorkflow.test.ts`. Aucune constante legacy remplacée (`src/shared/contracts.ts` inchangé, inutilisé).
  - Point ouvert : `tsconfig.server.json` (`rootDir: src/server`) empêche le serveur d'importer `src/shared/` (TS6059) — à lever en Task 02/04 (rootDir `src` + chemins `start`/Docker).
- [x] 02 — Migration du suivi prospect
  - `contact_tracking` : défaut `status='neutral'`, `next_action_year/next_action_week` (NULL possibles, CHECK couple complet + bornes ; validité S53 côté serveur via `isValidIsoWeek`), index `ix_contact_tracking_next_action`. Table `schema_migrations` (migration `2026-09-contact-02-next-action`, exécutée une fois par `migrate()` au démarrage/restauration/`npm run migrate`, rapport non-PII journalisé et stocké).
  - Base existante : reconstruction atomique (foreign_keys OFF le temps du DROP/RENAME, contrôle des compteurs et des FK, rollback sinon), instantané `VACUUM INTO <db>.before-<migration>-*.sqlite` préalable ; historique intact ; `contact_year/contact_week` conservés **gelés** (plus lus ni écrits ; suppression = migration de nettoyage ultérieure) ; seuls les couples ISO valides sont recopiés, le reste est compté (`legacyWeekUnmapped`, `plannedDateWithoutWeek`) pour la Task 03.
  - Statuts legacy **non convertis** (Task 03) et écritures applicatives toujours explicites en `to_contact` (Task 03/04). Lectures/écritures serveur redirigées vers `next_action_*` (alias `contact_year/contact_week` conservés dans l'API liste/export).
  - `tsconfig.server.json` : `rootDir: src` (+ `src/shared`) ; sortie `dist-server/server/index.js`, script `start` mis à jour.
  - `doc/architecture/data-model.md` décrit l'ancienne pile Postgres/Python : non modifié.
- [ ] 03 — Réconciliation des données legacy
- [ ] 04 — Service backend de suivi manuel
- [ ] 05 — Badges d’état et de semaine réutilisables
- [ ] 06 — Planification depuis Prospection
- [ ] 07 — Nettoyage dashboard Prospection
- [ ] 08 — Renommer Exploitation en Contact
- [ ] 09 — Dashboard et filtres Contact
- [ ] 10 — Workbench Contact split view
- [ ] 11 — Schéma des messages Contact/R1/R2
- [ ] 12 — API et machine d’état des messages
- [ ] 13 — Éditeur mail et onglets Contact/R1/R2
- [ ] 14 — Génération OpenAI
- [ ] 15 — Adaptateur CIRCOE Toolbox MCP
- [ ] 16 — Programmation différée et annulations
- [ ] 17 — Régression, hardening, docs et rapport final

## Comment choisir la prochaine tâche

Prendre la première tâche non cochée dont les dépendances sont satisfaites. Ne pas sauter une migration ou un contrat partagé pour aller directement à l’UI.

## Gates globaux

À chaque milestone :

```bash
npm test
npm run typecheck
npm run lint
npm run build
```

À la fin :

- aucun label de pipeline « Inconnu » ;
- aucun statut global « Validé / Non validé » ;
- aucun auto-classement mail/Calendly ;
- aucun email non validé envoyé ;
- aucune réactivation d’un `Ignoré` ;
- aucune double émission d’un email programmé ;
- page Contact utilisable de bout en bout avec brouillons locaux, puis avec intégrations activées.

## Baseline (Task 00 — 2026-09-29)

- Branche de travail réelle : `claude` (et non `GPT` comme l'indique le README) ; commit de départ `3fb8eb6`. Working tree : seuls `data/`, `dist-client/`, `dist-server/` non suivis (artefacts locaux).
- Stack conforme à l'audit (`src/server/index.ts`, `src/client/App.tsx`, `src/server/schema.ts` monolithiques).
- `npm run typecheck` : OK. `npm run build` : OK.
- `npm test` : **échec préexistant** — Vitest collecte aussi l'ancien dossier `frontend/` (legacy, hors périmètre) : 52 fichiers / 305 tests en échec, tous sous `frontend/`. Les tests de l'application réelle (`npx vitest run tests`) : 4 fichiers / 43 tests OK. **Gate retenu : `npx vitest run tests` doit rester vert** ; la collecte de `frontend/` est traitée en Task 17.
- `npm run lint` : **échec préexistant** — 110 erreurs / 3 warnings (majoritairement `no-explicit-any`). **Gate retenu : aucune nouvelle erreur de lint** (compte ≤ 110) ; nettoyage éventuel en Task 17.
- Skills `/caveman` et `/coding-guideline` absents de `~/ai/skills/` sur ce poste : les tâches suivent les conventions du code existant (style compact, TypeScript strict, Zod).
- Ordre des tâches confirmé (séquentiel, un sous-agent par tâche). Les décisions de `docs/01-decision-log.md` supersèdent `references/source-de-verite.md` en cas de conflit.
