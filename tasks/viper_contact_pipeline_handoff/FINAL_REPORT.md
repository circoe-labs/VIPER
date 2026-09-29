# Rapport final — VIPER Contact

## Résumé

Le lot Contact est implémenté de bout en bout sur la branche `claude` (Tasks 00 à 17) :

- états prospect manuels (`neutral` sans badge, Contacté, R1, R2, Réponse reçue, RDV pris, Failure, Ignoré) ;
- prochaine semaine ISO séparée de l'état ;
- nettoyage de Prospection ;
- page Contact avec compteurs, filtres et workbench (fiche à gauche, séquence mail à droite) ;
- messages Contact/R1/R2 avec validation humaine ;
- génération OpenAI (brouillon seulement) ;
- brouillons Infomaniak via la CIRCOE Toolbox ;
- envoi programmé idempotent.

Les gates sont vertes : tests, typecheck, lint (0 erreur, contre 110 à la baseline) et build. Un scénario bout en bout piloté en navigateur passe (39/39), avec de faux OpenAI et Toolbox. La migration a été vérifiée sur une copie de la base locale réelle.

**Ce qui est testé, et comment.** OpenAI, la CIRCOE Toolbox et Infomaniak n'ont **jamais été appelés en réel**. Pour la Toolbox, seules 2 requêtes GET anonymes de découverte OAuth ont été faites en Task 15. Tout le reste est testé contre des faux serveurs locaux. En production, ces intégrations restent désactivées tant qu'on ne les configure pas :

- sans clé OpenAI, la génération renvoie une erreur explicite ;
- `TOOLBOX_MAIL_ENABLED=false` par défaut ;
- aucun envoi n'a lieu sans Toolbox connectée.

## Commits / branche

Branche `claude` (commit de départ `3fb8eb6`), non poussée.

| Tâche | Commit | Sujet |
| --- | --- | --- |
| 00 | `de20461` | Import du handoff, baseline |
| 01 | `0a7647e` | Contrat de workflow partagé (états, étapes, semaines ISO, cadence) |
| 02 | `2c6c243` | Migration du suivi (`neutral`, `next_action_year/week`) |
| 03 | `8eb02bd` | Réconciliation des statuts legacy |
| 04 | `d4ddfc7` | Service backend de suivi manuel |
| 05 | `3da84e6` | Badges d'état et de semaine |
| 06 | `c90ceb4` | Planification de semaine depuis Prospection |
| 07 | `dd940ca` | Nettoyage du dashboard Prospection |
| 08 | `e1bfd90` | Exploitation → Contact |
| 09 | `48a71dc` | Dashboard et filtres Contact |
| 10 | `8410275` | Workbench Contact |
| 11 | `f2dc3ec` | Schéma des messages |
| 12 | `8bd66db` | API et machine d'état des messages |
| 13 | `3407c24` | Éditeur mail et onglets |
| 14 | `7c3fbd8` | Génération OpenAI |
| 15 | `6967b2f` | Adaptateur CIRCOE Toolbox MCP |
| 16 | `bfe390a` | Envoi programmé et annulations |
| 17 | `aca117c` | `npm test` limité à `tests/`, fixtures `migrate()` sans fsync par ligne (tests instables) |
| 17 | `746588b` | Typage explicite à la place de `any` (lint 102 → 0) |
| 17 | `0e3a925` | Suppression de `src/shared/contracts.ts` (ancienne taxonomie inutilisée) |
| 17 | `3fc5e2e` | Correctif : horodatages SQLite lus en UTC côté client |
| 17 | `fea08d9` | README et `.env.example` |
| 17 | (ce commit) | Rapport final, TODO |

## Tâches réalisées

Toutes les tâches 00 à 17 sont cochées dans `tasks/TODO.md`. Chaque tâche y a sa note d'implémentation détaillée : fichiers, règles et tests.

La Task 17 a apporté les éléments suivants :

- **Gate `npm test`** : `vite.config.ts` déclare `test.include = tests/**/*.test.ts` et exclut `frontend/`, `backend/` et `dist-*`. Le legacy n'est ni supprimé ni modifié.
- **Tests instables** : la cause était la construction de la base legacy sur disque en autocommit, soit un fsync par INSERT. Sous charge, cela prenait plusieurs secondes et dépassait le timeout de 5 s. La fixture est maintenant construite en mémoire puis écrite d'un bloc. Le test passe de ~1,1 s à ~0,2–0,4 s. Aucun timeout n'a été allongé.
- **Lint** : les 101 `no-explicit-any` ont été remplacés par des types réels (`src/client/apiTypes.ts` pour les réponses d'API lues par `App.tsx`, lignes SQL typées). Les `exhaustive-deps` sont corrigés sans changer les relances. Il reste un seul `eslint-disable-next-line react-hooks/set-state-in-effect`, justifié en commentaire : la réinitialisation du Drawer à chaque changement de fiche, conservée pour ne pas modifier l'ordre vu par l'auto-sauvegarde du brouillon.
- **Bug corrigé** : les dates `CURRENT_TIMESTAMP` SQLite (UTC sans fuseau) étaient affichées comme heure locale. Exemple : « État choisi le … 15:06 » pour un choix fait à 17:06 à Paris. Sont concernés l'historique des états, la provenance et la base de calcul de la cadence proposée. Correction : `src/client/serverDate.ts` (`normalizeServerTimestamp`) + test.
- **Reliquat supprimé** : `src/shared/contracts.ts` (`to_contact`, `quote_sent`, `won`…, « À contacter »), qui n'était plus importé nulle part.
- **Docs** : README et `.env.example` mis à jour, puis ce rapport.

## Changements de schéma et migrations

Les migrations sont exécutées par `migrate()` (`src/server/db.ts`) au démarrage, après une restauration, ou via `npm run migrate`. Chacune ne s'applique qu'une fois, grâce à la table `schema_migrations`. Chacune produit un rapport sans donnée personnelle, journalisé et stocké.

| Migration | Contenu | Sécurité |
| --- | --- | --- |
| `2026-09-contact-02-next-action` | `contact_tracking` reconstruite : défaut `neutral`, `next_action_year/next_action_week` (CHECK couple complet + bornes), index. `contact_year/contact_week` conservés gelés (plus lus ni écrits). | Instantané `VACUUM INTO` préalable, transaction, contrôle des compteurs et des FK, rollback sinon. |
| `2026-09-contact-03-legacy-statuses` | Mapping docs/06 §2 : `to_contact`→`neutral`, `follow_up_1/2`→`r1/r2`, `quote_*`/`won`→`appointment_obtained`, `not_interested`→`ignored` si `do_not_contact` sinon `failure`. Historique ancien jamais réécrit, une ligne d'historique `system` par conversion. Valeurs inattendues laissées telles quelles et signalées. | Instantané si des lignes changent, transaction unique, dry-run disponible, audit. |
| `2026-09-contact-11-messages` | Tables `contact_messages` (une par prospect et par étape, CHECK d'intégrité, trigger « envoyé immuable »), `contact_message_events` (journal sans contenu), `contact_message_remote_draft_cleanups` (file de suppression Toolbox). | Additive. |

**Vérification Task 17 sur une copie de `data/viper.sqlite`** : la copie a été placée dans un dossier temporaire. Le hash SHA-256 de l'original a été contrôlé identique avant et après.

- Avant : 325 prospects, 325 suivis tous `to_contact`, 247 entreprises, 232 emails, 326 lignes d'import. Pas de colonne `contact_week` (schéma plus ancien).
- `npm run migrate` (build) : les 3 migrations sont appliquées, 2 instantanés `.before-*` sont créés, et le rapport indique `to_contact->neutral: 325`.
- Après : 325 prospects, 325 suivis `neutral`, 325 lignes d'historique ajoutées (0 avant), entreprises, emails, sources et lignes d'import inchangés. `integrity_check=ok`, 0 violation de FK. **Aucune ligne perdue.**
- Second passage : état strictement identique (idempotence).
- Serveur démarré sur la copie migrée : dashboard Contact et liste (325 prospects `neutral`) répondent correctement.

## Workflow prospect implémenté

- **Service unique d'écriture** : `src/server/contactTrackingService.ts`.
  - Un acteur humain authentifié est exigé. L'import passe par un chemin dédié.
  - L'état et la semaine sont indépendants.
  - La cadence +2/+2/+4 est seulement **proposée** (`suggestedNextAction`), jamais appliquée.
  - Rien ne change avec le temps ni après un envoi.
- **`ignored`** : pose `do_not_contact` (jamais levé). C'est un état terminal : aucune sortie, même humaine, faute de décision « dé-ignorer ». Il est ignoré par l'import et le réimport, et exclu de Contact.
- **Annulation** : `response_received`, `appointment_obtained` et `ignored` annulent les messages non envoyés, dans la même transaction (décision 29). La suppression des brouillons distants est faite après commit, par une file dédiée.
- **UI**
  - Badges d'état et de semaine distincts, aucun badge pour `neutral`.
  - Planification de la semaine depuis la fiche Prospection et depuis le workbench Contact.
  - Confirmation avant les états qui annulent des messages.
  - Prospection réduite à 4 cartes-filtres (Tous, Contacts dus, Emploi à vérifier, Emails à fiabiliser).
  - Contact : « À traiter cette semaine » (premier contact / relances / revues R2), « RDV pris » cumulés, filtres semaine et état.

## Workflow email implémenté

- **Statuts** : `draft → validated → scheduled → sent`, et `cancelled`.
  - Toute édition d'un message validé ou programmé le ramène à `draft` (revalidation obligatoire, `revision` + verrou optimiste).
  - `sent` est immuable, en SQL et dans le service.
  - `scheduled` exige une date `scheduled_at` future avec fuseau. Aucune heure par défaut.
  - Chaque étape a sa propre validation humaine.
  - `reopen` d'un message annulé n'est possible que si la séquence est ouverte, donc jamais après `ignored`.
- **API** : `GET/PUT /api/prospects/:id/messages[/:step]`, puis `POST …/validate|schedule|unschedule|cancel|reopen|generate`. Il n'existe **aucune route « envoyer »** : seul le dispatcher appelle `markSent`, et il faut son verrou.
- **Éditeur** : onglets Contact/R1/R2 accessibles au clavier ; De/À/Cc/Cci/Objet/Corps ; confirmations avant validation, programmation et annulation ; gestion des conflits 409 sans écrasement ; lecture seule pour les messages envoyés, annulés ou dont la séquence est fermée. Pas de pièces jointes.

## Intégration OpenAI

- **Modèle configuré** : aucun par défaut. `OPENAI_MODEL` est obligatoire, avec `OPENAI_API_KEY`. Sans eux, l'erreur `ai_not_configured` (503) est renvoyée sans aucune écriture. Adaptateur : API Responses avec sortie structurée stricte `{ subject, body }` et `store: false`.
- **Version du prompt** : `contact-mail-fr-2026-09-v1` (`src/server/mailGenerationPrompt.ts`). Le prompt interdit d'inventer des faits, signale les données manquantes, n'inclut ni coordonnées ni lien hors `CONTACT_BOOKING_URL`, et n'ajoute pas de signature nominative.
- **Secrets** : côté serveur uniquement. Ils ne sont jamais renvoyés au client ni journalisés. Les logs `[ai]` ne contiennent que l'étape, le code et le statut amont.
- **Tests**
  - `tests/mailGeneration.test.ts` (22 tests, faux fetch) : succès, sorties invalides, refus, timeout, retries bornés, configuration, prompt, service.
  - `tests/mailGenerationUi.test.ts` (6 tests).
  - Scénario bout en bout avec un faux serveur OpenAI local : clé transmise, modèle et version de prompt enregistrés, résultat en Brouillon.
- **Non testé en réel** : aucun appel à l'API OpenAI. La qualité rédactionnelle et l'identifiant de modèle sont à valider par l'utilisateur.

## Intégration CIRCOE Toolbox

- **Authentification** : OAuth 2.1 Authorization Code + PKCE S256, avec enregistrement dynamique (client public), `resource` = URL MCP exacte et `scope=mail`.
  - Le `state` est à usage unique et lié à l'utilisateur ; `iss` est vérifié.
  - Le flux est lancé depuis Paramètres > « Connecter la Toolbox ».
  - Le jeton Bearer dure 30 jours, sans refresh token : il devient « À reconnecter » à l'expiration ou sur un 401.
  - Le fichier des jetons est privé (0600), hors dépôt et hors base.
- **Outils MCP utilisés** : `infomaniak.mail.create_draft` (à la validation), `send_draft` (dispatcher), `delete_draft` (file de nettoyage après édition, annulation ou remplacement), `list_drafts` (réconciliation). Client JSON-RPC Streamable HTTP en `fetch` natif, réponses JSON ou SSE.
- **Comportement en erreur** : `ToolboxError` typée (`toolbox_not_configured`, `auth_required`, `unavailable`, `timeout`, `rejected`, `outbound_blocked`, `invalid_input`, `draft_not_found`, `invalid_response`), avec les attributs `retryable` et `outcomeUnknown`.
  - Un échec de création de brouillon laisse le statut intact.
  - Un envoi incertain n'est jamais rejoué.
  - Le texte d'erreur Toolbox n'est jamais stocké ni journalisé.
- **Environnement réellement testé** : **uniquement le faux serveur** `tests/support/fakeToolbox.ts` (OAuth + MCP, mêmes formes et mêmes textes d'erreur que `circoe-toolbox` au commit `60ad176`). Couvert par les tests unitaires, les smokes des Tasks 15/16 et le scénario Task 17. Jamais contre la Toolbox de production ni Infomaniak.

## Scheduling

- **Mécanisme** : dispatcher dans le process serveur (`src/server/contactMessageDispatcher.ts`), avec un scan toutes les `CONTACT_DISPATCH_INTERVAL_MS` (30 s par défaut, 0 = désactivé).
  - Il ne démarre que si la Toolbox est activée et configurée, et ne fait rien tant qu'elle n'est pas connectée.
  - Un message programmé en retard de plus de 6 h revient à « Validé » sans partir.
- **Idempotence**
  - Le verrou est un UPDATE conditionnel dans une transaction IMMEDIATE (`dispatch_claim_id`), avec revérification de l'état prospect, de la révision, de la validation et du brouillon distant.
  - Un seul `send_draft` par message, y compris avec des passes concurrentes ou deux connexions sur la même base (testé).
  - Une issue inconnue conserve le verrou puis donne lieu à une réconciliation, jamais à un renvoi automatique.
- **Reprise après redémarrage** : un verrou orphelin (plus de 10 min) est réconcilié via `list_drafts`.
  - Brouillon absent ⇒ `sent` (« envoi déduit »).
  - Brouillon présent ⇒ retour `validated` avec `send_not_confirmed`, pour revue humaine.
  - Liste pleine ⇒ attente.
  - Testé avec `kill -9` pendant un `send_draft` lent (smoke Task 16).

## Tests exécutés

Résultats du 29/09/2026, branche `claude`, sur Windows 11 et Node 24.19.

```text
npm test:           21 fichiers, 351 tests, 351 OK — 3 exécutions successives vertes (11,7 s / 12,0 s / 11,6 s),
                    plus 3 exécutions simultanées vertes (contrôle de charge des anciens tests instables)
npm run typecheck:  OK (server + client)
npm run lint:       0 erreur, 0 warning (baseline : 110 erreurs / 3 warnings ; avant Task 17 : 102 / 3)
npm run build:      OK (tsc server + vite build)
```

Répartition des tests :

| Fichier | Tests | Fichier | Tests |
| --- | --- | --- | --- |
| contactWorkflow | 28 | contactMessageService | 39 |
| contactTrackingMigration | 12 | contactMail | 32 |
| contactTrackingReconciliation | 11 | mailGeneration | 22 |
| contactTrackingService | 27 | mailGenerationUi | 6 |
| trackingBadges | 8 | toolbox | 24 |
| weekPlanning | 11 | contactDispatcher | 26 |
| prospectionDashboard | 8 | navigation | 5 |
| contactDashboard | 15 | contactWorkbench | 13 |
| contactMessages | 21 | legacy (importer, drafts, roles, sqlSafety) | 43 |

### Couverture docs/04 → tests

| Exigence docs/04 | Preuve |
| --- | --- |
| Nouveau prospect `neutral`, aucun badge | `contactTrackingService` « un nouveau prospect est neutral… » ; `contactWorkflow` « default state is neutral without any badge » ; `trackingBadges` « aucun pour neutral » |
| `neutral + week` = semaine seule | `trackingBadges` « neutral + S40 montre S40 sans badge d'état » ; E2E (Alice) |
| `contacted/r1/r2 + week` = état + semaine | `trackingBadges` « R1 + S44 … deux badges distincts » ; E2E (Bruno « Contacté » + « S37 ») |
| Réponse/RDV/Failure/Ignoré sélectionnables | `contactTrackingService` « transitions libres… » ; `contactWorkbench` « propose les 8 états du contrat » |
| Aucune transition automatique (envoi, temps) | `contactTrackingService` « aucune transition automatique avec le temps… » ; `contactDispatcher` « … à l'heure => un envoi, `sent`, prospect inchangé » ; E2E |
| `ignored` bloque durablement et résiste au réimport | `contactTrackingService` « ignored pose do_not_contact… ne peut plus être quitté », « un import ou un réimport ne réactive jamais un ignored » ; E2E (réimport Excel réel) |
| Cadence S40→S42→S44→S48, jamais forcée | `contactWorkflow` « Contact S40 -> R1 S42 -> R2 S44 -> review S48 » ; `contactTrackingService` « … sans changer la semaine ni l'état » ; `weekPlanning` |
| Génération IA ⇒ `draft` | `mailGeneration` « génération => Brouillon… » ; `contactMessageService` « Task 14 : contenu généré => draft » |
| `draft` jamais envoyé | `contactMessageService` « markSent exige scheduled… draft et validated jamais envoyés » ; `contactDispatcher` « brouillon et validé jamais envoyés » |
| Validation manuelle requise | `contactMessageService` « validation humaine » (5 tests) ; `contactMessages` « exigent la validation humaine de la révision courante » |
| Édition d'un validé/programmé ⇒ `draft` | `contactMessageService` « édition d'un validated => draft », « édition d'un scheduled => draft » |
| `sent` non modifiable | `contactMessageService` « sent n'est jamais modifiable » ; `contactMessages` « un message envoyé est immuable » (trigger) |
| `scheduled` seulement avec `scheduled_at` valide | `contactMessageService` « date absente, invalide, sans fuseau, passée… refusée » ; `contactMessages` (CHECK) |
| Réponse/RDV/Ignoré ⇒ messages futurs annulés, `sent` intact | `contactMessageService` « changement manuel vers réponse reçue / RDV / ignoré… sent inchangé » ; `contactMessages` « annule draft/validated/scheduled, laisse sent intact » ; E2E (David) |
| Dispatcher : non validé jamais envoyé, jamais trop tôt | `contactDispatcher` « brouillon et validé jamais envoyés ; programmé jamais avant l'heure » ; E2E |
| Deux scans concurrents ⇒ un envoi | `contactDispatcher` « deux passes concurrentes… », « deux dispatchers (deux connexions…) » |
| Redémarrage ne renvoie pas | `contactDispatcher` « redémarrage après verrou (process tué)… », « issue inconnue… jamais rejoué » |
| Erreur Toolbox tracée, jamais `sent` à tort | `contactDispatcher` « refus définitif… trace send_failed, retour Validé, jamais sent », « tentatives épuisées » |
| IA : clé absente ⇒ erreur, aucune écriture | `mailGeneration` « clé/modèle absents => ai_not_configured, aucune écriture » |
| IA : données manquantes | `mailGeneration` « données manquantes : générer avec le contexte disponible… » |
| IA : prompt interdit l'invention | `mailGeneration` « interdit explicitement l'invention de signal, actualité, référence… » |
| IA : sortie validée côté serveur | `mailGeneration` « sortie invalide rejetée… » |
| Régénération ne valide pas | `mailGeneration` « régénération guidée d'un message validé… retour en Brouillon » |
| Migration : fixture des 10 anciens statuts, rapport, historique, aucune perte | `contactTrackingReconciliation` « convertit chaque statut legacy sans perte… », « préserve l'historique ancien… » ; `contactTrackingMigration` « reconstruit la table sans perte » ; copie réelle (ci-dessus) |
| UX : badges minimaux, état/semaine distincts | `trackingBadges` ; `prospectionDashboard` « au plus 6 cartes » |
| UX : cartes cliquables au clavier | `contactDashboard` « cartes et semaine… » ; `contactMail` « clavier : flèches… » ; smokes Tasks 06/09/10/13 au clavier |
| UX : pas de scroll horizontal global | E2E 1440 et 390 px ; smokes Tasks 09/10/13 |
| UX : fiche lisible pendant l'édition | Workbench fiche/mail côte à côte (smoke Task 10, capture E2E) |
| UX : états d'email sans jargon | `contactMessages` « labels FR sans jargon » ; `contactDispatcher` « lignes lisibles selon l'état » |
| UX : confirmation avant validation/programmation | `contactMail` « confirmations claires… » ; E2E |

Aucune exigence docs/04 n'était sans test. Un seul test a été ajouté en Task 17 : les horodatages serveur, avec le correctif.

## Scénarios de régression manuels

**Scénario bout en bout Task 17 : 39/39 vérifications OK.** Le script est hors dépôt, dans le scratchpad de session.

Environnement :

- serveur buildé (`dist-server`, port 3717) sur une base temporaire (`VIPER_DB_PATH` dans un dossier temporaire, jamais `data/`) ;
- Vite (port 5717, proxy `/api`) ;
- faux OpenAI local (port 3917) ;
- faux Toolbox (`tests/support/fakeToolbox.ts`) ;
- dispatcher toutes les 1 s ;
- Edge headless piloté en CDP.

Tous les processus ont été arrêtés à la fin : aucun process `msedge`, `vite` ou `dist-server` restant, ports libérés.

1. Connexion par le formulaire, puis **import Excel synthétique** par la modale (4 lignes).
2. **Prospection**
   - 4 cartes-filtres : Tous 4, Contacts dus 2.
   - Alice (neutre + S40) : seulement le badge S40. Bruno : « Contacté » + « S37 ». David : aucun badge.
   - Aucun « Inconnu », « À contacter », « Vérifiés » ni « Incomplets » affiché.
   - Fiche de David > Suivi de contact > « Planifier S40 » : persisté, état toujours `neutral`, carte mise à jour.
3. **Paramètres** : connexion Toolbox OAuth (retour sans cookie, `state` vérifié), état « Connectée ».
4. **Contact**
   - Compteurs : À traiter 4 = Premier contact 3 + Relances 1 + Revues 0 ; RDV 0.
   - Carte Relances : Bruno seul, puis re-clic pour revenir.
   - Filtre d'état « Contacté », puis réinitialisation.
   - Pas de scroll horizontal à 1440 px.
5. **Alice**
   - « Générer avec l'IA » : Brouillon (modèle et version de prompt enregistrés, De = `DEFAULT_OUTBOUND_EMAIL`, À = email principal).
   - Édition enregistrée (révision 2, toujours Brouillon). Aucun brouillon distant à ce stade.
   - « Valider… » + confirmation : Validé, et brouillon Infomaniak (faux) créé avec le contenu validé.
   - Date et heure vides par défaut, programmation à T+2 min (heure locale exacte).
   - **Aucun envoi avant l'heure.** À l'heure : **1 seul `send_draft`**, statut Envoyé. Toujours 1 seul après plusieurs passes.
   - Alice reste `neutral` S40 : aucune transition automatique.
   - Après rechargement, l'onglet affiche « Envoyé » en lecture seule.
6. **David**
   - Contact créé à la main, validé et programmé pour le lendemain (brouillon distant créé). R1 généré en Brouillon.
   - « Réponse reçue » + confirmation : Contact et R1 annulés, semaine retirée, brouillon Infomaniak supprimé par la file de nettoyage.
   - Éditeur verrouillé. Toujours 1 seul envoi au total.
7. **Claire**
   - « Ignoré » + confirmation « définitif » : À ne plus contacter, semaine retirée.
   - **Réimport du même Excel** (qui porte S40 pour elle) : elle reste Ignoré, bloquée, sans semaine.
   - Alice et David ne sont pas réécrits, aucun doublon (4 prospects).
   - Claire est absente de Contact. Un `PATCH` vers `neutral` est refusé (409 `ignored_is_terminal`).
8. Contact à 390 px : pas de scroll horizontal.
9. Logs serveur : aucune adresse email, aucun contenu de message, aucune clé ni aucun jeton.

Ce scénario a révélé le bug d'horodatage corrigé en `3fc5e2e` (visible sur la capture : « État choisi le … 15:06 » à côté de « Annulé … 17:06 »).

Scénarios antérieurs (détails dans `TODO.md`) :

- smokes navigateur des Tasks 06, 07, 08, 09, 10 et 13 (clavier, 390/1440 px) ;
- smokes HTTP des Tasks 12 (24/24) et 14 (23/23) ;
- Toolbox, Task 15 (23/23) ;
- dispatcher avec `kill -9` pendant un envoi, Task 16 (16/16) ;
- migration legacy (tests + copie réelle ci-dessus).

## Décisions produit respectées

- [x] **Pas de statut pipeline Inconnu** (décision 1).
  - Preuves : `prospectionDashboard` « aucun compteur Inconnu ni statut global Validé / Non validé », « aucun libellé Inconnu / Vérifiés / Non vérifiés / Incomplets » ; `trackingBadges` « aucun libellé legacy « À contacter » / « Inconnu » » ; E2E (texte de Prospection).
  - Restent, hors pipeline : le champ legacy `activity_status` « Inconnu » dans la fiche (docs/06 §3) ; les libellés d'export des champs activité/email ; le nom de repli `Inconnu` d'une ligne d'import sans identité ; le diagnostic d'import « Inconnus » (valeur de vérification Excel).
- [x] **Pas de Validé/Non validé global prospect** (décision 2) : mêmes tests `prospectionDashboard`. La colonne « Emploi » ne reflète que la vérification des informations d'emploi.
- [x] **neutral sans badge** (décision 4) : `trackingBadges`, `contactWorkflow` ; E2E.
- [x] **Badge semaine séparé** (décision 5) : `trackingBadges` « deux badges distincts », « état sans semaine et semaine sans état » ; E2E.
- [x] **Transitions de statut humaines** (décision 10) : `contactTrackingService` « exige un acteur humain authentifié », « aucune transition automatique avec le temps » ; `contactDispatcher` (prospect inchangé après envoi) ; E2E. Par grep, aucune lecture de boîte mail, webhook ni Calendly dans `src/`.
- [x] **Contact/R1/R2 à +2/+2 semaines** (décisions 11-12) : `contactWorkflow` « Contact S40 -> R1 S42 -> R2 S44 -> review S48 » ; `weekPlanning`.
- [x] **Revue après R2 à +4 semaines, sans auto-Failure** (décision 13) : mêmes tests ; `contactDashboard` « R2 + semaine = revue, pas une relance » ; aucun code ne pose `failure` automatiquement.
- [x] **Réponse reçue / RDV pris / Ignoré annulent les futurs emails après décision humaine** (décision 29) : `contactMessageService` « changement manuel vers réponse reçue / RDV / ignoré => messages futurs annulés, sent inchangé » ; `contactMessages` « branché sur le service de suivi… même transaction » ; `contactDispatcher` « réponse reçue avant l'heure : messages annulés, aucun envoi » ; E2E (David).
- [x] **IA = rédaction uniquement** (décisions 22 et 26) : `mailGeneration` « génération => Brouillon… aucune transition prospect », « payload strict : aucun statut » ; `contactMessageService` « Task 14 : … jamais validé ».
- [x] **Aucun email non validé envoyé** : aucune route d'envoi ; `markSent` exige `scheduled` + validation de la révision courante + verrou (`contactMessageService`) ; contrainte SQL (`contactMessages`) ; `contactDispatcher` « brouillon et validé jamais envoyés », « édition après programmation : l'ancienne révision ne part jamais » ; E2E.
- [x] **Ignoré persistant** (décision 7) : `contactTrackingService` « ignored … ne peut plus être quitté », « un import ou un réimport ne réactive jamais un ignored » ; `contactMessageService` « ignoré : jamais de réouverture » ; E2E (réimport + 409).

Gates globaux du TODO :

- **Aucune double émission** : `contactDispatcher` (passes concurrentes, deux connexions, redémarrage, issue inconnue) ; E2E (1 `send_draft`).
- **Page Contact utilisable de bout en bout** : avec brouillons locaux (smokes Tasks 10/13) et avec intégrations activées (E2E Task 17, faux serveurs).

## Points ouverts / limitations

**Intégrations non validées en réel**

- Aucun appel réel à OpenAI ni à la Toolbox/Infomaniak. À valider par l'utilisateur :
  - qualité des textes et identifiant de modèle ;
  - parcours de connexion réel (compte Infomaniak, collage du token API, membre approuvé du registre Toolbox) ;
  - URI de redirection HTTPS en production.
- **From non transmis** : la Toolbox n'a pas de champ `from`. L'expéditeur réel est la boîte par défaut du token Infomaniak lié. `DEFAULT_OUTBOUND_EMAIL`/`from_email` ne sert qu'à l'affichage, et un From différent n'est pas signalé.
- **Reconnexion tous les 30 jours** : pas de refresh token Toolbox. Après expiration, plus aucun brouillon ni envoi jusqu'à ce qu'un humain se reconnecte. Un message programmé pendant cette période revient à « Validé » après 6 h de retard.
- **Connexion Toolbox unique côté serveur** : pas de connexion par utilisateur VIPER. « Oublier » efface seulement le jeton VIPER : il n'existe pas de révocation côté Toolbox.

**Envoi programmé**

- **Réconciliation par absence de brouillon** : si un envoi a une issue inconnue et que le brouillon est supprimé à la main dans le webmail entre-temps, le message est compté « envoyé (déduit) ». Il n'y a jamais de double envoi, mais un envoi manqué reste possible.
- **Message verrouillé bloqué si plus de 100 brouillons** : une réconciliation non concluante (liste des brouillons tronquée) laisse le message verrouillé, sans action humaine possible dans l'UI.
- **Restauration d'une sauvegarde antérieure à un envoi** : le message réapparaît « Programmé » et pourrait repartir. Garder `TOOLBOX_MAIL_ENABLED=false` et revoir les messages programmés avant de réactiver.
- Un changement d'état du prospect pendant l'aller-retour `send_draft` ne peut plus arrêter cet envoi : il est signalé (`inFlightMessages`).
- La Toolbox ne renvoie pas de Message-ID (`remote_message_id` null).
- Le brouillon est envoyé tel qu'il est dans Infomaniak, même s'il a été modifié dans le webmail.

**Données et fonctionnalités non traitées**

- **`planned_contact_at` legacy** : colonne conservée (import, export, API), affichée en lecture seule. Sa suppression demande une migration de nettoyage non actée. Même chose pour `contact_year/contact_week`, gelés.
- **Signature et mention de désinscription** non générées : aucun modèle n'a été validé (source de vérité §4.4).
- **Complétude moyenne de la base** non implémentée : formule non actée (docs/08 §1).
- L'année 2026 est figée pour les « Sxx » de l'import Excel.
- `appointment_at` n'est pas posé par le passage à « RDV pris ». Le compteur « RDV pris » repose sur l'état courant.
- Pas de pièces jointes (docs/08 §6).
- Changer de prospect abandonne les modifications mail non enregistrées sans avertissement.
- L'état du brouillon distant n'est visible que par les lignes d'état d'envoi.

**Hors périmètre, préexistants**

- Sous 760 px, la barre de navigation latérale est masquée par le CSS existant, et il n'y a pas de menu mobile.
- Sessions en mémoire (perdues au redémarrage).
- `SESSION_SECRET` n'est pas lu.
- Identifiants par défaut publics si `VIPER_USER_*` ne sont pas définis.
- L'explorateur `/api/database/table/:name` interpole le nom de table (authentifié).
- `doc/`, `backend/` et `frontend/` décrivent l'ancienne pile et n'ont pas été mis à jour. La source de vérité du lot est `docs/01-decision-log.md` du handoff, référencée par le README.

## Rollback / sauvegarde

- Avant chaque migration qui réécrit des lignes, un instantané complet est pris : `viper.sqlite.before-<migration>-<horodatage>.sqlite`, à côté de la base.
- Sauvegarde à chaud : `GET /api/state/backup` et copie IndexedDB du navigateur. Les jetons Toolbox ne sont pas dans la base (fichier séparé).
- **Rollback** :
  1. Arrêter le serveur.
  2. Mettre `TOOLBOX_MAIL_ENABLED=false`, ou `CONTACT_DISPATCH_INTERVAL_MS=0` pour garder les brouillons sans envoi.
  3. Remplacer `viper.sqlite` par l'instantané et supprimer `-wal`/`-shm`.
  4. Redémarrer : les migrations se rejouent sur la base restaurée.
  5. Revoir les messages « Programmé » avant de réactiver l'envoi.
- Le code applicatif peut être ramené à `3fb8eb6`. La base migrée reste lisible, mais l'ancien code réécrirait `to_contact`. Restaurer donc aussi l'instantané `before-2026-09-contact-02-*` si l'on revient au code d'avant.

## Recommandations pour le prochain lot

1. Faire valider en réel, sur un compte de test Infomaniak, avec une allowlist d'envoi (`INFOMANIAK_SEND_ALLOWLIST`) : la connexion Toolbox, un brouillon, un envoi, puis OpenAI avec le modèle choisi. Garder `CONTACT_DISPATCH_INTERVAL_MS=0` jusqu'à cette validation.
2. Côté Toolbox : demander un refresh token ou une identité de service (pour éviter la reconnexion tous les 30 jours), un champ `from`/alias, et un Message-ID dans `send_draft` (preuve d'envoi directe).
3. Ajouter dans l'UI une action humaine pour les messages bloqués en réconciliation (« marquer envoyé / non envoyé » avec vérification dans le webmail).
4. Protéger la restauration de sauvegarde contre la reprogrammation d'envois passés (par exemple, tous les messages `scheduled` repassent à `validated` à la restauration).
5. Acter puis implémenter : la signature et la mention de désinscription, la formule de complétude, la migration de nettoyage (`planned_contact_at`, `contact_year/contact_week`, `activity_status` « Inconnu »), et la saisie de `appointment_at` depuis Contact.
6. Hors lot : navigation mobile, sessions persistantes, remise à niveau de `doc/` sur la pile réelle.
