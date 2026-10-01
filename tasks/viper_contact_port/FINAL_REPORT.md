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
| S7 — envoi programmé + clôture | `1b49b9e` dispatcher, réconciliation, CLI · `f5600c9` UI et scénario de bout en bout · `c0dbc8b` docs, runbook, décisions C-24…C-27 · `0f8154e` test du worker sur ses propres sessions · `f3e461c` rapport final · `2641d05` corrections QA (issue inconnue jamais rejouée, ordre des verrous, texte d'erreur non reconnu = issue inconnue, « Remettre en Validé » après le délai, relecture) · (commit suivant) rapport final mis à jour |

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
- **C-25** verrou PostgreSQL (le prospect et le suivi verrouillés en partage **avant** le message, puis toutes les
  conditions revérifiées) ; **une issue inconnue n'est jamais rejouée automatiquement** (comme la référence, après
  retour QA) : après le délai, brouillon disparu ⇒ envoyé (déduit), brouillon présent ⇒ retour en Validé
  (`send_not_confirmed`), liste tronquée ⇒ reste verrouillé ; seul un verrou **sans issue enregistrée** (process mort)
  est réessayé ; pour `send_draft`, tout texte d'erreur non reconnu est une issue inconnue ; codes `send_*` /
  `dispatch_*` distincts des `toolbox_*` ;
- **C-26** « Marquer envoyé » (à tout moment) / « Remettre en Validé » (seulement après le délai du verrou : l'appel
  Infomaniak de la Toolbox n'a pas de timeout) — recommandation 3 du rapport de référence ;
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
- **idempotence** : prospect et suivi verrouillés en partage, puis la ligne du message (`SKIP LOCKED`), toutes les
  conditions revérifiées (dont allowlist et ordre des étapes) juste avant `send_draft` ; `send_draft` hors
  transaction ; un verrou n'est relâché pour un nouvel essai qu'après un échec **certain**, ou par la réconciliation
  d'un verrou **sans issue enregistrée** dont le brouillon est encore là ; issue inconnue ⇒ verrou conservé, jamais
  de renvoi automatique ; testé avec deux sessions concurrentes et contre la sonde d'interblocage de la QA ;
- **reprise** : verrou périmé (TTL 10 min ≥ 2 × délai Toolbox) réconcilié par `list_drafts` : brouillon absent et
  liste complète ⇒ « envoyé (déduit) » ; présent après une issue inconnue ⇒ retour en Validé (vérifier les éléments
  envoyés puis reprogrammer) ; présent sans issue enregistrée ⇒ nouvel essai borné (et si ce réessai trouve le
  brouillon disparu ⇒ « probablement envoyé », verrou conservé) ; liste tronquée/illisible ⇒ reste verrouillé,
  réglable par une personne ;
- **garde-fous** : retard maximal 6 h (jamais d'envoi tardif), 5 tentatives avec backoff, allowlist
  `VIPER_INFOMANIAK_SEND_ALLOWLIST` appliquée à To/Cc/Cci, ordre des étapes, recréation du brouillon manquant (avec la
  règle de récupération S6), jamais un message non validé ni une autre révision que la validée ;
- **UI** : confirmation et ligne « Programmé » selon `automatic_sending_active`, états d'envoi dans l'éditeur, bandeau
  « Envoi non confirmé » avec « Marquer envoyé… » / « Remettre en Validé… » (confirmations), état du dispatcher dans
  Paramètres › Connexions.

## Tests exécutés (gate finale après les corrections QA, 2026-10-01, Windows 11, lancée seule)

Commandes : `python scripts/check_private_data.py` ; dans `backend/` : `ruff check . ../scripts`,
`ruff format --check . ../scripts`, `mypy` (configuration de `pyproject.toml`), `pytest` ; dans `frontend/` :
`npm run lint`, `npm run typecheck`, `npx vitest run --maxWorkers=3`, `npm run build`,
`npx playwright test --workers=3`. Les nombres de fichiers sont ceux qu'affichent ruff format (« 237 files already
formatted ») et mypy (« no issues found in 237 source files »), le garde de confidentialité (« 791 tracked files »).

```text
privacy guard      OK (791 fichiers suivis)
ruff check         OK            ruff format --check  OK (237 fichiers)
mypy               OK (237 fichiers)
pytest             1286 passed, 2 skipped (≈ 5 min) — dont 32 tests du dispatcher (test_contact_dispatch.py)
eslint             0 erreur      tsc -b               OK
vitest --maxWorkers=3   770 passed (63 fichiers)
vite build         OK (avertissement préexistant de taille de chunk)
playwright --workers=3  106 passed (projets chromium, toolbox, contact-flow ; 6,1 min)
```

Gate précédente (avant les corrections QA) : pytest 1279, vitest 767, Playwright 106 — verte aussi.

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
   envoyés, **et que le brouillon a quitté le dossier Brouillons et n'apparaît plus dans `list_drafts` juste après
   l'envoi** (la réconciliation en dépend) ; noter si la réponse porte `provider.etop` / `cancelResource`
   (annulation d'envoi d'Infomaniak), que VIPER ignore aujourd'hui.
5. Puis `VIPER_CONTACT_DISPATCH_INTERVAL_MS=30000`, refaire le test avec le worker, puis retirer l'allowlist.
6. Sauvegardes : après toute restauration, `python -m app.cli contact-dispatch --hold-scheduled` **avant** de
   démarrer l'API.
7. Reconnecter la Toolbox tous les 30 jours ; surveiller « Envois non confirmés » dans Paramètres › Connexions.

Pas à pas détaillé : `doc/process/runbook-production.md` § *Enabling the Contact features*.

## Risques résiduels

- Envoi déduit par absence du brouillon : un brouillon supprimé à la main pendant une issue inconnue est compté envoyé
  (jamais de double envoi, un envoi manqué possible).
- Une issue inconnue n'est jamais rejouée (C-25) ; reste un cas : un verrou **sans issue enregistrée** (process tué
  pendant `send_draft`) dont le brouillon est encore là après le délai est réessayé — si Infomaniak gardait un
  brouillon en cours d'envoi (non observé ; la Toolbox envoie le brouillon sur place), un double envoi serait possible
  dans la fenêtre de retard. À vérifier au premier envoi réel (checklist, point 4).
- Un brouillon resté présent après une issue inconnue revient en Validé : un humain doit vérifier les éléments envoyés
  avant de reprogrammer (dit dans l'éditeur).
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
  a ses propres sessions), 3 passages verts puis gate verte. Gate finale après corrections QA : verte du premier coup.

## Vérifications Humaines requises

1. Relire les captures `test-results/screenshots/contact-sent-*`, `contact-unconfirmed-*`,
   `settings-connections-dispatch-*` (DA Neon Command).
2. Valider C-24 (ordre des étapes, étape précédente absente non bloquante) et C-25 tel que réécrit (issue inconnue
   jamais rejouée ; seul un verrou sans issue enregistrée est réessayé) — choix d'orchestration, pas des décisions
   produit du handoff.
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

## Suppression de l'ancienne application racine (2026-10-01, décision Humaine)

L'application Node/SQLite à la racine (`src/`, `tests/`, `package.json`, `vite.config.ts`, `tsconfig.*.json`,
`eslint.config.js`, `index.html`, `public/`, `docs/`, `tasks-status.md`, `.env.example` racine) a été supprimée à la
demande de l'utilisateur, avec ses sorties de build non suivies (`dist-client/`, `dist-server/`, `node_modules/`).
Le README racine est revenu à celui de la pile réelle (`eeb0123`), complété par la page Contact et une section
Configuration. Les commentaires et documents qui citent `src/server/…`, `src/shared/…` ou les tests racine comme
implémentation de référence renvoient désormais à l'historique Git : cette implémentation reste consultable au commit
`2bd1c3b` (`git show 2bd1c3b:src/server/contactMessageDispatcher.ts`). `backend/.env.example` documente maintenant aussi
les variables `VIPER_CONTACT_DISPATCH_*`.

La base de développement `viper` a été migrée jusqu'à `0011` (elle était déjà en `0009`), après une sauvegarde
`pg_dump` hors du dépôt (`C:\Users\Clarice\viper-backups\viper-before-0010-20261001-170303.dump`).

## S8 — Réglages dans le navigateur (demandes Humaines du 2026-10-01)

Demandes : « configurer mes API KEY directement dans le navigateur … outil interne, je reverrai le bon process plus
tard », puis « laisse-moi me connecter à Circoe Toolbox DEPUIS la configuration VIPER … arrête la configuration côté
variable d'environnement ». Décision : C-28 du decision log ; doc : `doc/features/settings-connections.md`.

**Ce qui change pour l'utilisateur.** Une installation sans `backend/.env` se configure entièrement dans Paramètres ›
Connexions, sans redémarrage. Quatre cartes, chacune avec son bouton principal : *Rédaction IA (OpenAI)* (clé en
écriture seule, modèle sans valeur par défaut, lien RDV, plus en « Paramètres avancés » l'adresse de l'API, le délai et
les nouvelles tentatives ; *Tester la clé*), *Expéditeur*, *CIRCOE Toolbox* (**« Se connecter à CIRCOE Toolbox »**
fonctionne d'emblée : l'adresse de la Toolbox est intégrée au code et l'adresse de retour est celle de la page ; le
clic active l'intégration ; « Se déconnecter… » efface le jeton et la désactive) et *Envoi programmé* (fréquence
**désactivée par défaut**, liste d'adresses autorisées). Chaque champ indique sa provenance (défini ici / configuration
du serveur / par défaut) et propose « Rétablir la valeur par défaut ». L'interface ne demande jamais de variable
d'environnement ni de redémarrage.

**Contrat d'API.** `GET/PUT /api/settings/integrations` (valeurs effectives, `source`, `fallback`, métadonnées de la
clé `{set, last4, source, updated_at, updated_by}` mais jamais la clé, `generation_available`, résumés Toolbox et
dispatcher ; PUT partiel, `null` = rétablir, `version` = jeton de concurrence → 409 `conflict`, 422 `invalid` +
`field`, personne connectée seulement, CSRF). `POST /api/settings/integrations/openai/check` (`GET
{base}/models/{model}`, rien n'est généré). `POST /api/settings/toolbox/connect {redirect_uri}` active l'intégration
et enregistre l'adresse de retour (marquée `auto` : remplacée lors d'une connexion depuis une autre adresse, sauf si
elle a été saisie à la main ou fixée par l'environnement). `POST …/forget` = se déconnecter **et** désactiver.

**Stockage et précédence.** Fichier JSON privé `VIPER_RUNTIME_SETTINGS_PATH` (par défaut
`~/.viper/runtime-settings.json`), hors base et hors dépôt (refusé dans le checkout), écriture atomique, `0600`/`0700`
sous POSIX (sous Windows : l'ACL du profil). **La clé OpenAI y est en clair** : accepté pour le pilote interne, à
revoir. Précédence : valeur saisie dans l'UI > `VIPER_*` > défaut. La validation passe par `Settings.model_validate`,
donc **exactement les validateurs du démarrage** (aucune copie) ; un fichier illisible ou devenu invalide est signalé
(`load_error`) puis ignoré jusqu'au prochain enregistrement. Audit `settings.integrations_changed` (valeurs avant et
après, sauf la clé : `openai_api_key: replaced|removed` dans la raison) ; `api_key` est ajouté aux fragments secrets de
la politique d'audit. Nouveaux défauts : URL MCP de la Toolbox CIRCOE, `contact_dispatch_interval_ms = 0`.

**Application à chaud.** `IntegrationRuntime` (`app.state.integrations`, un verrou, un seul process) remplace
`app.state.settings`, que les routes lisent à chaque requête (client OpenAI construit par requête, lien RDV,
expéditeur). Un changement de l'interrupteur ou des URL Toolbox reconstruit `app.state.toolbox` ; une connexion OAuth
en cours est alors perdue, le fichier de jeton est conservé. Les workers de nettoyage et d'envoi ne tournent **que
lorsque la Toolbox est connectée** : ils démarrent au démarrage si elle l'est déjà ou juste après le retour OAuth,
redémarrent quand les réglages d'envoi changent et s'arrêtent à la déconnexion. Le CLI `--once` lit le même fichier.

**Tests.** pytest : `tests/test_runtime_settings.py` (35 tests). Ils couvrent le stockage (écriture atomique, refus
dans le dépôt, permissions sous POSIX, fichier cassé), la précédence UI > env > défaut, la **parité de validation**
(chaque valeur invalide est refusée à la fois par `Settings(...)` et par le PUT, avec le même `field`), une clé jamais
présente dans les réponses, les logs, l'audit ni le `repr`, une clé saisie qui rédige sans redémarrage (transport
simulé : le Bearer est bien la nouvelle clé), la connexion depuis la page qui active la Toolbox puis démarre les
workers, le changement de fréquence qui recrée le dispatcher, l'allowlist qui l'atteint, « Désactivé », la
déconnexion qui arrête tout, l'adresse de retour `auto` comparée à une adresse saisie, une adresse de page refusée,
le 409 de concurrence, le CSRF, et *Tester la clé* (ok, 401, 404, 429, 500, injoignable). Un garde autouse fait
échouer tout test qui toucherait l'hôte de la vraie Toolbox, et chaque test dispose de son propre fichier de
réglages (jamais `~/.viper`). vitest : `IntegrationCards.test.tsx` (12 tests) et `ConnectionsSection.test.tsx`
(13 tests, réécrit). Playwright : `e2e/connections.spec.ts`, projet `connections`, lancé en dernier et seul ; il
remet tous les réglages aux défauts avant et après. Le spec saisit une clé refusée par le faux OpenAI : *Tester* et
la génération le disent. Il saisit ensuite une autre clé, le modèle et l'adresse de l'API : la génération utilise
cette clé (le faux le confirme par les 4 derniers caractères) sans redémarrage. Côté Toolbox : adresse vidée →
« Non configurée » ; adresse http non locale refusée sous le champ ; adresse du faux saisie ; fréquence choisie ;
« Se connecter à CIRCOE Toolbox » (la requête `/authorize` part bien vers le faux, jamais vers l'hôte réel) →
« Connectée » et envoi *Actif* ; puis « Se déconnecter… ». Le fichier de réglages de l'E2E est temporaire et propre
à chaque port. `toolbox.spec` et `contact-flow.spec` sont adaptés aux nouveaux libellés.

**Gate.** `verify.py` : ruff, ruff format, mypy, **pytest 1321 passed / 2 skipped**, eslint et tsc verts ; le vitest
de `verify.py` a fini avec 5 échecs de charge (des expirations de délai à 5 s sur des fichiers non modifiés ; machine
saturée), relancé avec `npx vitest run --maxWorkers=3` : **788/788**, puis **789/789** après le correctif ci-dessous.
Playwright `--workers=3` : **107 passed, 1 failed**. L'échec était un vrai défaut, pas la charge : après
l'enregistrement de l'adresse manquante, la section « Paramètres avancés » se refermait (son `open` suivait l'état
« Non configurée ») et masquait son propre message de succès. Corrigé (une section ouverte n'est jamais refermée
sous l'utilisateur) et couvert par un test vitest. Le projet `connections` a été relancé seul : 2/2.

**Captures** (revues contre la DA Neon Command : cartes `.settings-connection`, primitives `ui/fields`, un seul
bouton principal par carte, aucune couleur en dur, pas de débordement à 1440) : `test-results/screenshots/
connections-{openai,toolbox-connected,toolbox-disabled}-{dark,light}-1440.png` et
`connections-toolbox-refused-dark-1440.png`.

**Risques résiduels.** Clé OpenAI en clair dans un fichier du profil, remplaçable par toute personne connectée
(décision Humaine, à revoir) ; sous Windows la protection repose sur l'ACL du profil. Hypothèse d'un seul process API
(un second ne verrait les changements qu'à son redémarrage). L'enregistrement d'un réglage de la Toolbox ou de
l'envoi peut attendre la fin d'une passe en cours (bornée par le délai de la Toolbox) ; une connexion OAuth commencée
puis interrompue par une reconfiguration est à relancer. Si l'audit échoue après l'écriture du fichier, la
configuration est appliquée sans événement d'audit (fichier et base ne sont pas atomiques ensemble). Un jeton expiré
laisse les workers tourner à vide jusqu'à la reconnexion. L'adresse de retour exige VIPER en https ou sur localhost.
Les variables `VIPER_*` restent des valeurs par défaut, utiles aux tests et à l'E2E : une variable fixée côté
serveur s'affiche « Valeur fournie par la configuration du serveur ».

### S8 — reprise après QA indépendante (verdict REWORK : 1 bloquant, 3 majeurs)

- **B1 (bloquant) — le jeton Toolbox suivait l'URL MCP enregistrée.** (a) Le jeton est désormais lié à la ressource
  pour laquelle il a été délivré (`ToolboxAuth.bound`, `same_url`) : un jeton émis pour une autre adresse compte comme
  « non connecté » et n'est jamais envoyé (état, `access_token`, `refresh_after_unauthorized`, donc les workers). (b)
  Un changement ou une réinitialisation de `toolbox_mcp_url` efface le jeton dans `IntegrationRuntime.apply` (audit
  `toolbox.forgotten`, raison `toolbox_mcp_url changed`) et arrête les workers. La page demande une confirmation
  avant (« Changer l'adresse du serveur ? … déconnecte la Toolbox »). Tests : `seen == []` sur le faux après
  changement d'adresse ; jeton lié à A, serveur B → état, accès, `CleanupWorker.run_once` et client MCP ne font
  aucun appel.
- **M1 — la clé OpenAI pouvait partir vers n'importe quelle adresse d'API.** Une clé saisie ici est stockée avec
  l'adresse d'API de cet enregistrement (`bound_base_url`) ; la clé de l'environnement ne part que vers l'adresse de
  l'environnement ou l'adresse par défaut. Changer ou rétablir l'adresse sans ressaisir la clé dans le même
  enregistrement renvoie 422 `field: openai_api_key`, `reason: required_with_base_url`. La page l'annonce sous le
  champ clé et l'ouvre à la saisie. Tests : *Tester la clé* et rédaction n'utilisent que la nouvelle clé, vers la
  nouvelle adresse ; clé d'environnement face à une adresse saisie ici refusée ; clé liée ailleurs écartée au
  démarrage.
- **M2 — une « Adresse de retour » vidée cassait la connexion.** Un champ vidé équivaut désormais à « Rétablir »
  (`null`) pour tous les réglages, côté serveur comme côté page ; la connexion reprend l'adresse de la page.
- **M3 — VIPER ouvert en http sur le réseau local.** La 422 du *connect* sur `toolbox_oauth_redirect_uri` affiche le
  texte du champ (« ouvrez VIPER en https ou sur localhost »).
- **Mineurs.** m1 : seule la valeur fautive est écartée au démarrage, et `load_dropped` la nomme dans le bandeau
  (une clé sans modèle, ou liée à une autre adresse, part avec elle). m2 : un fichier impossible à écrire renvoie 503
  `settings_storage_unavailable` avec un texte en français, et rien n'est appliqué. m3 : `save.reset()` après
  l'enregistrement d'une clé. m4 : `blockRealToolbox` (`context.route` → abort vers l'hôte réel) dans les specs
  toolbox, contact-flow et connections. m5 : une connexion OAuth commencée survit à une reconstruction quand le
  serveur et l'adresse de retour ne changent pas ; sinon son retour donne 409 `toolbox_connection_interrupted`
  (« connexion interrompue par un changement de réglage : recommencez »). m6 : un seul verrou (ré-entrant) couvre
  `update` + `apply`, et `GET /settings/integrations`, *Tester la clé* et *connect* lisent `app.state.settings` comme
  toutes les routes.
- **Détails.** La 422 de FastAPI (clé trop longue) s'affiche sous le champ ; le lien se nomme « Rétablir » (son
  infobulle donne la valeur rétablie) ; « Se déconnecter » vide le fichier de jeton même intégration désactivée ;
  `StoredValue.__repr__` masque la valeur. Barre latérale : elle est `position: sticky; height: 100vh`. Dans le
  navigateur elle couvre toujours la hauteur visible ; la bande vide sous elle n'apparaît que sur les captures pleine
  page (`fullPage`). Ce n'est pas un défaut : rien n'a été changé.
- **E2E** : comme un champ vidé revient désormais à sa valeur par défaut, l'état « Non configurée » n'est plus
  atteignable depuis la page. La spec `connections` saisit donc l'adresse du faux avec une barre finale
  (`…/mcp/`, équivalente par `same_url`) ; le faux accepte `/mcp/`.

**Gate de la reprise.** `verify.py` vert du premier coup : ruff, ruff format, mypy, **pytest 1334 passed / 2 skipped**,
eslint, tsc, **vitest 799/799**, vite build. Playwright `--workers=3` : 99 passed, 1 failed
(`accessibility.spec.ts` « base de données (dark) », zone non touchée), 8 non lancés (projets dépendants). Relances
isolées : projets `toolbox` 4/4, `contact-flow` 2/2, `connections` 2/2 ; `accessibility.spec.ts` seul en
`--workers=3` : une première relance a échoué sur les 3 premiers tests, lancés à froid pendant que le backend
signalait `Database health check failed`, puis **22/22** à la relance suivante. Instabilité de démarrage sous charge,
sans lien avec S8.
