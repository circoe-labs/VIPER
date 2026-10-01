# Rapport final — Portage Contact vers `backend/` + `frontend/`

## Résumé

Le lot Contact (handoff `tasks/viper_contact_pipeline_handoff/`, Tasks 00-17), d'abord réalisé dans l'application
Node/SQLite racine (`src/`), est porté dans la pile réellement utilisée — **FastAPI + PostgreSQL (`backend/`) et
React (`frontend/`)** — en gardant strictement la DA Neon Command (aucun CSS ni mise en page repris de `src/client/`).
Branche `task/contact-port`, Slices S0 à S7 :

- **états prospect manuels** : 8 états (`neutral` sans badge, Contacté, R1, R2, Réponse reçue, RDV pris, Failure,
  Ignoré), migration des anciens statuts sans réécrire l'historique, semaine de prochaine action séparée de l'état,
  cadence +2/+2/+4 seulement proposée ;
- **Prospection et Accueil** adaptés (badges d'état et de semaine, planificateur, compteurs, segments) ;
- **page Contact** (ex-Exploitation) : compteurs « à traiter cette semaine », filtres, liste, poste de travail fiche à
  gauche + séquence mail Contact/R1/R2 à droite ;
- **messages** : Brouillon → Validé → Programmé → Envoyé / Annulé, révisions, validation humaine de la révision
  courante, édition ⇒ retour Brouillon, Envoyé immuable, annulation sur Réponse reçue / RDV pris / Ignoré / opposition ;
- **génération OpenAI** (brouillon seulement, prompt de référence identique, `store: false`) ;
- **CIRCOE Toolbox** : OAuth 2.1 + PKCE, jeton hors base, brouillons Infomaniak à la validation, file de suppression ;
- **envoi programmé** (S7) : dispatcher dans le process API, exactement-une-fois, réconciliation, règlement par une
  personne des envois non confirmés, garde-fou après restauration.

**Ce qui est testé, et comment.** OpenAI, la CIRCOE Toolbox et Infomaniak n'ont **jamais été appelés en réel**
pendant le portage (décision P6) : tout passe par des faux serveurs locaux (`backend/tests/fake_toolbox.py`,
`frontend/e2e/fake-toolbox.ts`, `frontend/e2e/fake-openai.ts`). En production, tout reste désactivé tant qu'un humain
ne le configure pas (voir la checklist en fin de rapport).

## Commits / branche

Branche `task/contact-port`, créée depuis `claude` @ `2bd1c3b`, non poussée (`git log --oneline 2bd1c3b..HEAD`).

| Slice | Commits |
| --- | --- |
| S0 — baseline | `ad2e266` gates au vert avant le portage · `f29089e` plan des Slices |
| S1 — modèle d'états | `137ab12` états Contact et migration 0008 · `6d5d35c` docs · `907ac5a` corrections QA · `c344950` acceptation |
| S2 — états dans l'UI | `a44f7ba` badges, planificateur · `fb9809b` docs · `d7d0694` corrections QA |
| S3 — Contact backend | `8ee74e5` table `contact_messages`, séquence, tableau de bord · `03014bd` corrections QA · `8bc10c6` acceptation S2+S3 |
| S4 — page Contact | `8e8d979` décision Humaine (compteurs Prospection) · `125ce74` page Contact · `48c65fd` corrections QA · `e8b1348` acceptation |
| S5 — OpenAI | `8674e6f` génération · `eb72995` corrections QA · `3f7624b` acceptation |
| (hors Slice) | `657779d` « fix trash from ChatGPT+ start work on CONTACT page » — commit Humain intercalé (config Toolbox, erreurs, sorties de build ajoutées par erreur, retirées en `bc1bef2`) |
| S6 — CIRCOE Toolbox | `0b6b08e` OAuth et brouillons Infomaniak · `97bc22e` stabilisation e2e · `bc1bef2` `dist-*` hors suivi · `54c47b0` décisions Humaines · `ae825eb` corrections QA · `8843f13` acceptation |
| S7 — envoi programmé + clôture | `1b49b9e` dispatcher, réconciliation, CLI · `f5600c9` UI et scénario de bout en bout · `c0dbc8b` docs, runbook, décisions C-24…C-27 · (ce commit) rapport final |

## Ce qui a été porté (vs l'implémentation de référence)

| Référence (`src/`) | Port (`backend/`, `frontend/`) |
| --- | --- |
| `shared/contactWorkflow.ts` | `app/services/contact_workflow.py`, `app/models/enums.py` |
| `server/contactTracking*.ts` | `app/services/contact_tracking.py`, import et réconciliation opérationnelle, migration `0008` |
| `server/contactDashboard.ts` | `app/services/contact_dashboard.py`, `GET /api/contact/dashboard|prospects` |
| `server/contactMessage*.ts` | `app/services/contact_messages.py`, `contact_message_cancellation.py`, migration `0009` |
| `server/openaiMailGenerator.ts`, `mailGenerationPrompt.ts` | `app/services/mail_generation/`, `contact_mail_generation.py` |
| `server/toolbox*.ts` | `app/services/toolbox/` (OAuth, jeton, MCP, intégration, worker), `contact_remote_drafts.py`, migrations `0010`/`0011` |
| `server/contactMessageDispatcher.ts` | `app/services/contact_dispatch.py`, `contact_dispatch_worker.py`, CLI `contact-dispatch` |
| `client/*` (UI rejetée) | `frontend/src/contact/`, `prospection/`, `prospects/`, `settings/ConnectionsSection.tsx` — DA existante, primitives `ui/` (nouvelles : `Tabs`, `CounterCards`) |

## Écarts et décisions

Décisions de portage (README) : **P1** semaine = `planned_contact_at` (lundi ISO), pas de colonnes
`next_action_year/week` · **P2** 8 états, `neutral`, migration des données, historique jamais réécrit · **P3** Accueil
adapté sans refonte · **P4** Exploitation → Contact (`/exploitation` redirige) · **P5** travaux de fond dans le
process API, désactivés par défaut, jumeau CLI `--once` · **P6** aucun appel réel, faux serveurs · **P7** règle
d'import « semaine passée → contacté ».

Journal produit (`doc/product/decision-log.md`) : **C-01…C-27**. Les principaux écarts vs la référence :

- **C-11** séquence close plus stricte (l'édition aussi est refusée) ; **C-12** l'opposition annule aussi les messages ;
- **C-19** `replace: true` explicite pour écraser un texte, garde-fous de sortie IA (pas de lien hors réservation,
  pas d'adresse, pas de champ à compléter), erreurs de configuration au démarrage ;
- **C-20** retour OAuth via la SPA + POST (session, CSRF), `state` lié à la personne ; jeton dans un fichier privé
  hors base et hors dépôt ;
- **C-21/C-23** échec de brouillon distant visible et durable (« Réessayer »), trigger de suppression, récupération
  `list_drafts` après issue inconnue ;
- **C-24** ordre des étapes à l'envoi (R1/R2 attendent ou reviennent en Validé si l'étape précédente est préparée
  mais non envoyée ; une étape précédente absente ou annulée ne bloque pas) ;
- **C-25** verrou PostgreSQL (`FOR UPDATE SKIP LOCKED` + revérifications + verrous partagés sur l'état et
  l'opposition) ; **un verrou périmé dont le brouillon est toujours dans la boîte est réessayé** (la référence le
  renvoyait en Validé) ; codes d'envoi `send_*` / `dispatch_*` distincts des `toolbox_*` ;
- **C-26** « Marquer envoyé » / « Remettre en Validé » (recommandation 3 du rapport de référence) ;
- **C-27** source d'audit `dispatcher`, drapeau `automatic_sending_active`, garde-fou `--hold-scheduled`
  (recommandation 4).

Décisions Humaines : pas de limite de compteurs Prospection (2026-09-30) ; expéditeur réel = boîte par défaut du
compte Infomaniak, connexion Toolbox unique côté serveur renouvelée tous les 30 jours (2026-10-01).

## Changements de schéma et migrations

| Migration | Contenu | Rollback |
| --- | --- | --- |
| `0008_contact_states` | CHECK des 8 états (défaut `neutral`), remap des données (`to_contact`→`neutral`, `follow_up_1/2`→`r1/r2`, `quote_*`/`won`→`appointment_obtained`, `not_interested`→`ignored` si opposition sinon `failure`), une ligne d'historique `system` + un événement d'audit par conversion, `ignored` perd sa semaine | `downgrade` **au mieux** : lignes `system` supprimées, états remappés vers l'ancien vocabulaire ; non restauré : la distinction RDV/devis/gagné, `ignored`/`failure` → `not_interested` |
| `0009_contact_messages` | table `contact_messages` (CHECK d'intégrité, index partiels, trigger « envoyé immuable ») — colonnes génération, brouillon distant et envoi déjà présentes (S5-S7 sans migration) | `downgrade` supprime la table : **les messages sont perdus** (sauvegarde avant) |
| `0010_remote_draft_cleanups` | file des brouillons Infomaniak à supprimer | `downgrade` supprime la table : lancer `toolbox-cleanup --once` avant |
| `0011_remote_draft_cleanup_on_delete` | trigger `BEFORE DELETE` qui met en file le brouillon d'un message supprimé | `downgrade` retire le trigger, remappe `deleted`→`cancelled` |

S7 n'ajoute aucune migration. Après `alembic upgrade head` : `python -m app.cli provision-sql-reader` (droits de la
console SQL). Toutes les migrations sont testées montée/descente sur `viper_test` (`test_migration_*.py`) ; jamais
exécutées sur la base de développement `viper` pendant le portage.

## Workflow prospect

Écriture unique `save_contact_tracking` (éditeur, `PATCH …/tracking`, Explorer, imports) : acteur humain pour un
changement d'état (403 sinon), `ignored` terminal qui renforce l'opposition, états fermants qui annulent les messages
non envoyés dans la même transaction, cadence proposée (`suggested_next_contact_week`), jamais appliquée. Rien ne
change avec le temps ni après un envoi : **l'envoi d'un message ne modifie jamais l'état du prospect** (testé côté
backend et dans le scénario e2e).

## Workflow email

Machine d'état de `app/services/contact_messages.py` (seul chemin d'écriture), verrou optimiste `expected_revision`,
validation humaine de la révision courante, programmation à un instant explicite futur (≤ 1 an, aucune heure par
défaut), Envoyé immuable (service + trigger), annulation/réouverture. Aucune route « envoyer » : seul le dispatcher
envoie ; `mark-sent` n'existe que pour trancher un envoi non confirmé.

## Intégration OpenAI

- modèle : **aucun par défaut** (`VIPER_OPENAI_MODEL` obligatoire avec la clé) ; version de prompt
  `contact-mail-fr-2026-09-v1` (texte de référence à l'octet) ; Responses API, schéma strict `{subject, body}`,
  `store: false` ;
- secrets : clé côté serveur uniquement, jamais journalisée ni renvoyée ; logs = identifiants, codes, durées ;
- tests : `test_mail_generation.py`, `test_contact_mail_generation.py` (faux transport), e2e contre `fake-openai.ts`.

## Intégration CIRCOE Toolbox

- authentification : OAuth 2.1 + PKCE S256, enregistrement dynamique, `resource`, `iss`, jeton 30 jours sans refresh,
  fichier privé `0600` hors base et hors dépôt ;
- outils MCP : `create_draft` (validation), `delete_draft` (file de nettoyage), `send_draft` (dispatcher),
  `list_drafts` (récupération et réconciliation) ;
- erreurs : `ToolboxError` typée (`retryable`, `outcome_unknown`), texte de la Toolbox jamais conservé ni journalisé ;
- environnement réellement testé : **faux Toolbox uniquement** (Python `httpx2.MockTransport`, Node en e2e), mêmes
  formes et textes d'erreur que `circoe-toolbox` @ `60ad176`.

## Scheduling (S7)

- **mécanisme** : thread du process API (`VIPER_CONTACT_DISPATCH_INTERVAL_MS`, 30 s ; 0 = aucun), démarré seulement
  si la Toolbox est activée et configurée, inactif tant qu'elle n'est pas connectée ; CLI `contact-dispatch --once` ;
  arrêt propre (la passe en cours se termine) ;
- **idempotence** : verrou par ligne (`SKIP LOCKED`), toutes les conditions revérifiées, état et opposition relus sous
  verrou partagé juste avant `send_draft` ; `send_draft` hors transaction ; un verrou n'est relâché qu'après un échec
  **certain** ; issue inconnue ⇒ verrou conservé, jamais de renvoi ; testé avec deux sessions de base concurrentes ;
- **reprise** : verrou périmé (TTL 10 min ≥ 2 × délai Toolbox) réconcilié par `list_drafts` : brouillon absent et
  liste complète ⇒ « envoyé (déduit) » ; présent ⇒ nouvel essai borné ; liste tronquée/illisible ⇒ reste verrouillé,
  réglable par une personne ;
- **garde-fous** : retard maximal 6 h (jamais d'envoi tardif), 5 tentatives avec backoff, allowlist
  `VIPER_INFOMANIAK_SEND_ALLOWLIST` appliquée à To/Cc/Cci, ordre des étapes, recréation du brouillon manquant (avec la
  règle de récupération S6), jamais un message non validé ni une autre révision que la validée ;
- **UI** : confirmation et ligne « Programmé » selon `automatic_sending_active`, états d'envoi dans l'éditeur, bandeau
  « Envoi non confirmé » avec « Marquer envoyé… » / « Remettre en Validé… » (confirmations), état du dispatcher dans
  Paramètres › Connexions.

## Tests exécutés (gate finale S7, 2026-10-01, Windows 11)

```text
privacy guard      OK (790 fichiers suivis)
ruff check         OK            ruff format --check  OK (237 fichiers)
mypy               OK (237 fichiers)
pytest             1279 passed, 2 skipped (≈ 4 min) — dont 27 tests du dispatcher (test_contact_dispatch.py)
eslint             0 erreur      tsc -b               OK
vitest --maxWorkers=3   767 passed (63 fichiers)
vite build         OK (avertissement préexistant de taille de chunk)
playwright --workers=3  106 passed (projets chromium, toolbox, contact-flow ; 5,8 min)
```

## Scénarios de bout en bout

`frontend/e2e/contact-flow.spec.ts` (projet Playwright `contact-flow`, après `toolbox`), contre le vrai backend et les
faux serveurs : import Excel synthétique → planification de la semaine dans Prospection → connexion Toolbox (OAuth
dans le navigateur) → page Contact → brouillon IA → relecture et modification → validation (brouillon Infomaniak) →
programmation à la minute suivante (la confirmation annonce l'envoi automatique) → **envoi par le dispatcher de l'API,
un seul `send_draft`** → Envoyé, lecture seule, état inchangé → « Contacté » choisi par la personne → cadence R1
appliquée à la main → R1 rédigé, validé, programmé → « Réponse reçue » annule R1 et son brouillon Infomaniak est
supprimé → la liste affiche *Contact Envoyé · R1 Annulé*. Second test : la Toolbox envoie puis répond 502 et sa liste
de brouillons échoue → « Envoi non confirmé », aucun renvoi pendant les passes suivantes, « Marquer envoyé » confirmé.
Captures (sombre/clair, 1440) : état envoyé, envoi non confirmé, Paramètres › Connexions avec l'envoi programmé.

Grep des reliquats (Task 17) : les occurrences restantes de « À contacter », « Devis envoyé », « Relance 1 »,
« Inconnu », « Exploitation » sont légitimes — noms de colonnes du classeur historique (import), libellés d'historique
« (ancien) » des anciens codes, segment Prospection « À contacter » (C-07), statut d'activité « Inconnue » (hors
pipeline), commentaires de code.

## Décisions produit respectées

- [x] pas de statut pipeline Inconnu — [x] pas de Validé/Non validé global prospect — [x] neutral sans badge —
  [x] badge semaine séparé — [x] transitions de statut humaines (aucune après un envoi) — [x] Contact/R1/R2 à +2/+2
  semaines (proposées) — [x] revue après R2 à +4 semaines, sans auto-Failure — [x] Réponse reçue / RDV pris / Ignoré
  annulent les futurs emails — [x] IA = rédaction uniquement — [x] aucun email non validé envoyé — [x] Ignoré
  persistant.

## Ce qui n'a JAMAIS été exercé pour de vrai

- **OpenAI** : aucun appel ; qualité rédactionnelle et identifiant de modèle à valider par l'Humain.
- **CIRCOE Toolbox** : ni OAuth réel, ni MCP réel ; l'URL de production et l'acceptation de l'URI de redirection
  HTTPS de VIPER sont à vérifier avec le propriétaire de la Toolbox.
- **Infomaniak** : aucun brouillon, aucun envoi réels ; la sémantique « `send_draft` consomme le brouillon » (base de
  la réconciliation) vient de la référence et du code de la Toolbox, pas d'une observation.
- **Production** : aucun déploiement, aucune restauration de sauvegarde testée.

## Checklist de configuration Humaine avant production

1. `VIPER_DEFAULT_OUTBOUND_EMAIL` (indicatif), `VIPER_CONTACT_BOOKING_URL` si un lien de réservation est voulu.
2. `VIPER_OPENAI_API_KEY` (secret) + `VIPER_OPENAI_MODEL` (choix du modèle) ; `VIPER_OPENAI_TRUST_ENV=true` derrière
   un proxy.
3. `VIPER_TOOLBOX_MAIL_ENABLED=true`, `VIPER_TOOLBOX_MCP_URL`, `VIPER_TOOLBOX_OAUTH_REDIRECT_URI` (HTTPS),
   `VIPER_TOOLBOX_TOKEN_STORE_PATH` hors dépôt et hors sauvegardes ; connexion avec le compte Infomaniak **dont la
   boîte par défaut doit envoyer**.
4. **`VIPER_CONTACT_DISPATCH_INTERVAL_MS=0` et `VIPER_INFOMANIAK_SEND_ALLOWLIST=<adresse interne>`** pour le premier
   envoi réel, lancé à la main (`python -m app.cli contact-dispatch --once`) ; vérifier boîte de réception et éléments
   envoyés.
5. Puis `VIPER_CONTACT_DISPATCH_INTERVAL_MS=30000`, refaire le test avec le worker, puis retirer l'allowlist.
6. Sauvegardes : après toute restauration, `python -m app.cli contact-dispatch --hold-scheduled` **avant** de
   démarrer l'API.
7. Reconnecter la Toolbox tous les 30 jours ; surveiller « Envois non confirmés » dans Paramètres › Connexions.

Pas à pas détaillé : `doc/process/runbook-production.md` § *Enabling the Contact features*.

## Risques résiduels

- Envoi déduit par absence du brouillon : un brouillon supprimé à la main pendant une issue inconnue est compté envoyé
  (jamais de double envoi, un envoi manqué possible).
- Brouillon présent après le TTL ⇒ nouvel essai (C-25) : si Infomaniak gardait un brouillon déjà envoyé (comportement
  non observé), un double envoi serait possible dans la fenêtre de retard ; à vérifier lors du premier test réel.
- Le brouillon est envoyé tel qu'il est dans Infomaniak (une modification dans le webmail part avec lui).
- Plus de 100 brouillons dans la boîte ⇒ réconciliation non concluante ⇒ décision humaine nécessaire.
- Un changement d'état pendant l'aller-retour `send_draft` n'arrête pas cet envoi (signalé, `in_flight_messages`).
- Une seule connexion Toolbox (30 jours, pas de révocation distante) ; expéditeur = boîte par défaut du compte.
- Un seul process API attendu (le throttle de connexion est en mémoire) ; deux instances resteraient sûres pour
  l'envoi (verrous) mais doubleraient les passes.
- Tests sensibles à la charge connus : `auth.spec.ts:50` et `test_export_reads_20k_prospects…` — verts dans la gate
  finale, aucune relance nécessaire. Pendant la gate, un premier `vitest` complet a fini avec 3 erreurs de worker
  (716 tests exécutés, aucun en échec ; machine saturée) ; relancé seul : 767/767. Un test du dispatcher qui démarrait
  le thread du worker sur la connexion partagée du test a échoué une fois (savepoint concurrent) : corrigé (le thread
  a ses propres sessions), 3 passages verts puis gate verte.

## Vérifications Humaines requises

1. Relire les captures `test-results/screenshots/contact-sent-*`, `contact-unconfirmed-*`,
   `settings-connections-dispatch-*` (DA Neon Command).
2. Valider C-24 (ordre des étapes, étape précédente absente non bloquante) et C-25 (réessai d'un verrou périmé dont le
   brouillon est présent) — ce sont des choix d'orchestration, pas des décisions produit du handoff.
3. Premier envoi réel encadré (checklist ci-dessus), avec un compte Infomaniak de test.
4. Choisir le modèle OpenAI et relire quelques brouillons réels.

## Recommandations

1. **Application Node racine (`src/`, `tests/`, `dist-*`)** : elle duplique désormais tout le lot Contact avec une UI
   rejetée. Ne pas la supprimer dans ce lot ; recommander de l'archiver (tag ou branche) puis de la retirer de `main`
   dans un lot dédié, après accord Humain, pour lever l'ambiguïté sur l'application de référence.
2. Côté Toolbox : refresh token ou identité de service, champ `from`/alias, Message-ID dans `send_draft`, pagination de
   `list_drafts` (rendrait la réconciliation toujours concluante).
3. Tester une restauration de sauvegarde avec `--hold-scheduled` avant le pilote.
4. Hors lot : signature et mention de désinscription, saisie de `appointment_at` depuis Contact, nettoyage des
   colonnes legacy, navigation mobile.
