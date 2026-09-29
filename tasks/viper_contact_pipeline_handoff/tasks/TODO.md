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
- [x] 03 — Réconciliation des données legacy
  - `src/server/contactTrackingReconciliation.ts` : migration `2026-09-contact-03-legacy-statuses` (après celle de la Task 02 dans `migrate()`), une seule fois (`schema_migrations`), transaction unique avec contrôle des compteurs, instantané `VACUUM INTO` si des lignes vont changer, dry-run (`{ dryRun: true }` : même chemin puis rollback), rapport non-PII journalisé + stocké + `audit_log` (`schema_migration`).
  - Mapping exécuté (docs/06 §2) : `to_contact`→`neutral` (prochaine semaine conservée) ; `contacted`, `response_received`, `appointment_obtained` inchangés ; `follow_up_1`→`r1` ; `follow_up_2`→`r2` ; `quote_sent`/`quote_follow_up`/`won`→`appointment_obtained` ; `not_interested`→`ignored` si `contactability_status='do_not_contact'`, sinon `failure`.
  - Historique ancien jamais réécrit : chaque conversion ajoute une ligne `contact_tracking_status_history` (`from_status`=ancien statut, `actor_type='system'`, `actor_id`=id migration). `changed_at` = date de migration (donc `tracking_status_since` = date de migration pour les lignes converties).
  - `do_not_contact` : jamais levé ; un `ignored` sans blocage est renforcé en `do_not_contact` (audité par prospect). Non modifiés mais comptés : `do_not_contact` dans un autre état que `ignored`/`failure` (`doNotContactNotIgnored`), valeurs inattendues (`unexpectedStatuses`, laissées telles quelles + `console.warn`), neutres avec date legacy sans semaine (`neutralWithPlannedDateOnly`), semaines legacy non convertibles (`legacyWeekUnmapped`), `activity_status='unknown'` (`activityStatusUnknown`, nettoyage hors périmètre). Pas de CHECK SQL sur `status` (les inattendus bloqueraient la reconstruction).
  - Écritures : `toProspectStateForWrite` (vide→`neutral`, legacy→mappé, autre→400) sur `POST/PUT /api/prospects` et `import/commit` ; l'import ne fait avancer qu'un suivi `neutral` ; l'importer Excel produit la nouvelle taxonomie (`legacy_tracking_status` + diagnostic `legacy_status_mapped` pour le post-RDV). Lectures serveur dashboard/filtres/export alignées (`neutral`, `r1/r2`, labels du contrat).
  - Restent ouverts : année 2026 figée pour « Sxx » dans l'import Excel (non tranché par le decision log) ; `ignored` saisi via l'API ne pose pas encore `do_not_contact` (Task 04) ; client `App.tsx` toujours sur les anciens codes/labels (Tasks 05-09).
- [x] 04 — Service backend de suivi manuel
  - `src/server/contactTrackingService.ts` (`createContactTrackingService(db, { cancelFutureMessages?, now? })`) : seule porte d'écriture de `contact_tracking` ; `index.ts` n'y fait que déléguer (`POST/PUT /api/prospects`, `import/commit`). Erreurs typées `ContactTrackingError` (`code` + `httpStatus` : `prospect_not_found` 404, `invalid_payload`/`invalid_state`/`invalid_next_action` 400, `human_actor_required` 403, `ignored_is_terminal`/`ignored_has_no_next_action` 409), renvoyées `{ error, code }`.
  - API : `GET /api/prospects/:id/tracking` → `{ tracking | null, history }` ; `PATCH /api/prospects/:id/tracking` `{ status?, next_action_year?, next_action_week? }` (codes du contrat seulement, couple ISO complet, `null/null` = effacer) → `TrackingMutationResult` (`tracking`, `stateChanged`, `changed`, `doNotContactReinforced`, `cancelledMessages`, `suggestedNextAction`). Pas de spec API dans le repo (docs `doc/` = ancienne pile) : contrat documenté en tête du service.
  - Règles : acteur humain authentifié exigé (import = chemin dédié `applyImport`, acteur `import`) ; état et semaine indépendants ; entrer dans un état sans échéance par défaut (`response_received`, `appointment_obtained`, `failure`, `ignored`) efface la semaine (un humain peut en reposer une, sauf sur `ignored`) ; cadence seulement proposée (`suggestedNextAction`, jamais appliquée) ; historique une seule fois par changement d'état + audit `tracking_create/tracking_update` sans PII.
  - `ignored` : pose `do_not_contact` (audité, jamais levé, API et import) ; **terminal : aucune sortie via le service, même par un humain (choix conservateur, le decision log ne prévoit pas de « dé-ignorer »)** ; import/réimport ne change ni son état ni sa semaine.
  - Décision 29 : hook `cancelFutureMessages` appelé dans la transaction SQLite du changement d'état (une exception annule tout) ; défaut no-op tant que `contact_messages` n'existe pas — à brancher dans `trackingDeps` (`index.ts`) en Task 12 ; suppression des brouillons distants Toolbox à différer après commit (Task 16).
  - Compat client : `PUT /api/prospects/:id` accepte toujours codes legacy et alias `contact_year/contact_week` ; une semaine renvoyée identique (écho) n'est pas une saisie ; un statut inattendu renvoyé tel quel n'est plus rejeté. Un 409 annule toute la sauvegarde de la fiche (transaction unique).
  - Points ouverts : pas de test HTTP automatisé (`index.ts` démarre le serveur à l'import ; smoke manuel OK) ; aucune restriction d'état pour un prospect `do_not_contact` non `ignored` (non tranché) ; le client `App.tsx` ne connaît pas encore `neutral/r1/r2` (Tasks 05-09).
- [x] 05 — Badges d’état et de semaine réutilisables
  - `src/client/trackingDisplay.ts` (pur) : `stateBadgeModel` (`null` pour neutre/absent ; code hors contrat affiché tel quel, ton `unexpected`), `weekBadgeModel` (`S40`, année + lundi en infobulle/lecteur d'écran, couple ISO invalide = pas de badge), `stateOptionLabel` (neutre = « Aucun état »), `selectableState`, `historyStatusLabel` (codes legacy de l'historique lus via le mapping Task 03 + « (ancien suivi) »). `src/client/TrackingBadges.tsx` : `StateBadge`, `WeekBadge`, `TrackingBadges` (affichage seul). Conventions : état = pastille pleine colorée par famille (séquence Contacté/R1/R2, réponse, RDV, failure, ignoré) ; semaine = cadre pointillé monospace ; jamais de badge pour `neutral`.
  - Legacy client retiré : `trackingLabels`/`stagesWithNextAction`/`stageAfterAppointment`, fallback « À contacter », défauts `to_contact`. Branchés : carte Prospection (repliée), en-tête de la fiche, onglet suivi (sélecteur des 8 états du contrat, verrouillé si `ignored` enregistré ; semaine affichée en lecture seule), historique, aperçu d'import (semaine). Compteurs `due`/`contacted` alignés sur `neutral`/`r1`/`r2`, filtre rapide `status:to_contact` retiré.
  - `legacyTrackingStatuses`/`mapLegacyTrackingStatus` déplacés dans `src/shared/contactWorkflow.ts` (ré-exportés par `contactTrackingReconciliation.ts`) pour l'historique client.
  - Tests : `tests/trackingBadges.test.ts` (logique pure + rendu `react-dom/server`, pas de jsdom). Smoke manuel API + Vite sur base temporaire (10 prospects dans les 8 états, avec/sans semaine).
  - Restent (tâches suivantes) : édition de la semaine + champ legacy « Date prévue » `planned_contact_at` (06) ; cartes « Non vérifiés/Vérifiés/Incomplets » et colonne Vérification (07) ; Home (`Contacts dus` via `planned_contact_at`, prochaines actions sans badges) et recherche globale sans suivi (07/09) ; `activity_status` « Inconnu » (champ, pas pipeline). Pas de doc interface à jour dans le repo (`doc/` = ancienne pile).
- [x] 06 — Planification depuis Prospection
  - Fiche prospect, onglet « Suivi de contact », groupe « Planification » : `src/client/WeekPlanner.tsx` (année ISO + semaine ISO en `<select>` libellés `S40 · lun. 28 sept.`, boutons ‹/› précédente/suivante avec passage d'année S52/S53→S1, « Planifier Sxx » / « Déplacer en Sxx » / « Retirer l'échéance »). Enregistrement immédiat par `PATCH /api/prospects/:id/tracking` `{ next_action_year, next_action_week }` (jamais de `status` : `neutral` conservé, aucun historique d'état), puis rechargement de la liste (badge semaine sur la carte) et des badges de l'en-tête ; focus clavier ramené sur la semaine enregistrée, annonce `aria-live`. Bloqué sur un `ignored` enregistré (même règle que le service) ; nouvelle fiche : disponible après création.
  - Logique pure `src/client/weekPlanning.ts` (réutilise `contactWorkflow.ts`, aucun calcul de semaine dupliqué) : pré-remplissage = semaine enregistrée > semaine ISO de l'ancienne `planned_contact_at` > cadence (`suggestNextActionWeek` depuis la date du choix de l'état) > semaine courante, toujours à confirmer ; bouton « Proposition cadence : S42 (Contacté + 2 sem.) » seulement si différente de la sélection ; S53 ramenée à S52 si l'année choisie n'en a que 52.
  - `planned_contact_at` (« Date prévue ») : colonne conservée (import/export/API inchangés) mais retirée de l'UI principale : plus de saisie dans la fiche, plus de « Prévu … » sur la carte ; valeur existante affichée en lecture seule « Ancienne date prévue (legacy, non utilisée) ». Le `PUT /api/prospects/:id` de la fiche n'envoie plus la semaine (`withoutPlannedWeek`) : un brouillon ancien ne peut pas réécrire une semaine planifiée.
  - Prospection : filtre/compteur « Contacts dus » = `neutral` avec semaine ≤ semaine ISO courante (échues incluses) au lieu de `planned_contact_at` ; liste triée par (année, semaine), sans semaine en dernier (`nextActionDueFilter` / `nextActionOrderSql` dans `contactTrackingSchema.ts`). Pas de bouton « générer maintenant ? » (optionnel, Task 13/14).
  - Tests : `tests/weekPlanning.test.ts` (pré-remplissage, cadence, bords d'année 2026 S53/2027 S52, PATCH via service S40→S41→S1 2027→effacement sans changement d'état, brouillon ancien, filtre dû/tri). Smoke réel : API + Vite (base temporaire, ports 3417/5417) piloté par Edge headless (CDP) au clavier : planification persistée (PATCH vérifié par GET), carte mise à jour, S52 2027→S1 2028, effacement.
  - Restent : Home (`Contacts dus` et « Prochaines actions » via `planned_contact_at`) → 07/09 ; doc interface Prospection absente du repo (`doc/` = ancienne pile), contrat documenté ici et en tête de `WeekPlanner.tsx`/`weekPlanning.ts` ; suppression de la colonne `planned_contact_at` = migration de nettoyage ultérieure (non actée).
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
