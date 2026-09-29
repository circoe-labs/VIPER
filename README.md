# VIPER

**Validation Interface for Prospecting, Execution & Revenue**

VIPER est l’outil de prospection B2B de Circoe : une base de données de prospects (des personnes) et de leurs
entreprises, tenue à jour à la main, avec un suivi de contact léger. La V1 remplace le classeur Excel historique
sans en reprendre les confusions, et garde l’Excel comme format d’échange (import contrôlé, export normalisé).

Ce que fait la V1 :

- **Accueil** — l’état de la base (vérifications, e-mails, opposition), l’activité de contact du mois face aux
  objectifs, les prochaines actions et les dernières modifications ;
- **Prospection** — des compteurs qui filtrent une liste de personnes lisible, un éditeur de prospect (vérification
  explicite, adresses et téléphones, changement d’entreprise, opposition durable, « Enregistrer et suivant »), les
  fiches **Entreprises**, l’**import Excel** avec revue (correction, exclusion, doublons) et l’**export Excel** ;
- **Base de données** — un explorateur de tables (aperçu des 100 premières lignes) et une console SQL en lecture seule
  (requête filtrée côté serveur) ;
- **Paramètres** — rôles, catégories d’activité, segments commerciaux, référents internes et connexion à la CIRCOE
  Toolbox (brouillons et envoi Infomaniak) ;
- **Contact** — (ex-« Exploitation ») page de préparation des prises de contact par semaine : cartes-filtres
  « À traiter cette semaine » (premier contact / relances / revues R2) et « RDV pris » cumulés, filtres semaine ISO et
  état, liste sélectionnable ; un clic ouvre la fiche du prospect à gauche (lecture, choix manuel de l’état et de la
  semaine, lien vers la fiche Prospection pour corriger) et la séquence mail à droite : onglets Contact / R1 / R2
  (statut Brouillon, Validé, Programmé, Envoyé, Annulé ou Vide), éditeur type boîte mail (De prérempli depuis
  `DEFAULT_OUTBOUND_EMAIL`, À prérempli avec l’email principal, Cc/Cci, objet, corps). Workflow opérateur : rédiger puis
  « Créer le brouillon » / « Enregistrer » (n’envoie ni ne valide rien) → « Valider… » (confirmation) → choisir date **et**
  heure (heure locale, aucune valeur par défaut) → « Programmer… » (confirmation). Toute modification enregistrée d’un
  message validé ou programmé le repasse en Brouillon : il faut le revalider (et le reprogrammer). « Déprogrammer »
  garde la validation ; « Annuler le message… » l’écarte ; « Rouvrir » le repasse en Brouillon tant que la séquence
  est ouverte. Envoyé = lecture seule ; après « Réponse reçue », « RDV pris » ou « Ignoré », les messages non envoyés
  sont annulés et l’éditeur est verrouillé. « Générer / Régénérer avec l’IA » (consigne facultative) rédige objet et
  corps via OpenAI côté serveur (`OPENAI_API_KEY` + `OPENAI_MODEL` obligatoires, `OPENAI_BASE_URL`/`OPENAI_TIMEOUT_MS`/
  `OPENAI_MAX_RETRIES` et lien de RDV `CONTACT_BOOKING_URL` optionnels, voir `.env.example`) : résultat toujours
  Brouillon à relire et valider, confirmation avant de remplacer un contenu, aucune donnée inventée ni coordonnée
  envoyée, version du prompt enregistrée (`contact-mail-fr-2026-09-v1`). Avec la CIRCOE Toolbox activée et connectée, la
  validation crée un brouillon dans la boîte Infomaniak liée et le serveur envoie ce brouillon à l’heure programmée
  (une seule fois, jamais un message non validé) ; sans elle, tout reste local et rien ne part. L’état du prospect ne
  change jamais seul (ni après un envoi, ni avec le temps) : c’est toujours un choix humain. Pas de pièces jointes ; aucun
  agent, aucune lecture de boîte mail ni Calendly.

Chaque modification est tracée (qui, quand, depuis où) ; une opposition « Ne pas contacter » survit aux réimports.
Un seul utilisateur authentifié pour le pilote. L’interface est en français ; le code et la documentation technique
sont en anglais.

## Stack

L’application en service est à la racine du dépôt :

- `src/server/` — API Node.js (Express 5, better-sqlite3), migrations au démarrage (`src/server/db.ts`) ;
- `src/client/` — interface React + Vite ; `src/shared/` — contrats partagés (états, semaines ISO, statuts des messages) ;
- `tests/` — tests Vitest de l’application (`npm test`) ; `tests/support/fakeToolbox.ts` — faux serveur CIRCOE Toolbox.

`backend/` (FastAPI/PostgreSQL), `frontend/`, `docker-compose.yml` et `doc/` décrivent une ancienne pile : ils ne sont ni
lancés ni testés par les commandes ci-dessous (`npm test` ne collecte que `tests/`).

## Démarrage (PowerShell)

Prérequis : Node 24, Git. Aucune base externe (SQLite dans un dossier privé, hors du dépôt).

```powershell
npm ci
Copy-Item .env.example .env        # puis renseigner au moins VIPER_USER_EMAIL / VIPER_USER_PASSWORD
# Développement : API (tsx watch, :3001) + Vite (:5173, proxy /api -> :3001). Variables lues depuis l'environnement du shell.
npm run dev
# Production : build puis serveur (le client est servi depuis dist-client/ par un serveur statique ou un proxy)
npm run build
node --env-file=.env dist-server/server/index.js
```

Le serveur ne lit pas `.env` tout seul : passer `--env-file=.env` à Node (Node ≥ 20.6) ou exporter les variables. Avec
`NODE_ENV=production`, le cookie de session est `Secure` (HTTPS obligatoire). Sessions en mémoire : un redémarrage
déconnecte l’utilisateur.

Contrôles qualité : `npm test`, `npm run typecheck`, `npm run lint`, `npm run build` ; `npm run migrate` applique les
migrations sans démarrer le serveur.

## Configuration

Toutes les valeurs sont lues côté serveur uniquement (jamais envoyées au navigateur). Modèle commenté : `.env.example`.

| Variable | Défaut | Rôle |
| --- | --- | --- |
| `PORT` | `3001` | Port de l’API. |
| `VIPER_STORAGE_DIR` | `~/.viper` | Dossier privé : base SQLite, archives d’import, jetons Toolbox, instantanés de migration. |
| `VIPER_DB_PATH` | `<storage>/viper.sqlite` | Chemin complet de la base (prioritaire). |
| `VIPER_USER_EMAIL` / `VIPER_USER_PASSWORD` | valeurs d’exemple | Compte unique du pilote. **À changer** : les valeurs par défaut sont publiques. |
| `DEFAULT_OUTBOUND_EMAIL` | vide | « De » prérempli des messages (vide = à saisir). Non transmis à la Toolbox, qui expédie avec la boîte liée. |
| `OPENAI_API_KEY`, `OPENAI_MODEL` | vides | Génération IA ; tous deux obligatoires, sinon « Générer » renvoie une erreur explicite (`ai_not_configured`) sans rien modifier. Aucun modèle par défaut. |
| `OPENAI_BASE_URL`, `OPENAI_TIMEOUT_MS`, `OPENAI_MAX_RETRIES` | API officielle, 60 000, 2 | Options de l’adaptateur OpenAI (API Responses). |
| `CONTACT_BOOKING_URL` | vide | Lien de prise de rendez-vous que l’IA peut insérer (vide = aucun lien). |
| `TOOLBOX_MAIL_ENABLED` | `false` | **Feature flag** de l’intégration CIRCOE Toolbox (brouillons Infomaniak + envoi programmé). |
| `TOOLBOX_MCP_URL`, `TOOLBOX_OAUTH_REDIRECT_URI` | vides | URL MCP exacte de la Toolbox ; URI de retour OAuth vue par le navigateur (HTTPS, ou `localhost`/`127.0.0.1` en dev, ex. `http://localhost:5173/api/toolbox/oauth/callback`). |
| `TOOLBOX_TOKEN_STORE_PATH`, `TOOLBOX_TIMEOUT_MS`, `TOOLBOX_CLEANUP_INTERVAL_MS` | `<storage>/toolbox-oauth.json`, 20 000, 60 000 | Fichier des jetons (refusé dans le dépôt), délai par appel, période de suppression des brouillons obsolètes (0 = arrêt). |
| `CONTACT_DISPATCH_INTERVAL_MS` | 30 000 | Période du dispatcher d’envoi programmé ; **0 = aucun envoi automatique** (interrupteur d’urgence). |
| `CONTACT_DISPATCH_MAX_LATENESS_MS`, `CONTACT_DISPATCH_CLAIM_TTL_MS`, `CONTACT_DISPATCH_MAX_ATTEMPTS`, `CONTACT_DISPATCH_RETRY_BASE_MS` | 6 h, 10 min, 5, 60 s | Retard toléré (au-delà : retour « Validé », rien ne part), verrou orphelin (réconcilié, jamais renvoyé), tentatives et backoff sur erreur certaine. |

Activation de l’envoi réel : `TOOLBOX_MAIL_ENABLED=true` + URL/URI renseignées, puis **Paramètres > « Connecter la
Toolbox »** (OAuth 2.1 + PKCE ; la Toolbox demande la connexion Infomaniak puis un token API personnel Mail). Le jeton dure
30 jours sans renouvellement automatique : l’état passe alors à « À reconnecter » et plus rien ne part jusqu’à une
nouvelle connexion. Désactiver = remettre le flag à `false` (ou `CONTACT_DISPATCH_INTERVAL_MS=0` pour garder les brouillons
sans envoi) et redémarrer.

## Données, sauvegarde et retour arrière

- **Base** : `VIPER_DB_PATH` (défaut `~/.viper/viper.sqlite`, WAL). Sans `VIPER_DB_PATH` et sans base existante, une ancienne
  `./data/viper.sqlite` du checkout est copiée une fois vers le dossier privé (l’original n’est jamais modifié).
- **Migrations** : appliquées à chaque démarrage (et après une restauration), une seule fois chacune (table
  `schema_migrations`, rapport sans données personnelles dans les logs). Avant toute migration qui réécrit des lignes,
  un instantané complet est pris à côté de la base : `viper.sqlite.before-<migration>-<horodatage>.sqlite`.
- **Sauvegarde à chaud** : `GET /api/state/backup` (session requise) renvoie la base sérialisée ; le navigateur en garde
  aussi une copie (IndexedDB) et la restaure automatiquement si le serveur démarre sur une base vide. `POST
  /api/state/restore` est refusé si la base contient déjà des prospects.
- **Retour arrière** : arrêter le serveur, mettre `TOOLBOX_MAIL_ENABLED=false` (plus aucun envoi), remplacer
  `viper.sqlite` (et supprimer `-wal`/`-shm`) par l’instantané ou la sauvegarde voulue, redémarrer. Attention : une
  sauvegarde antérieure à un envoi fait réapparaître le message comme « Programmé » ; revoir les messages programmés
  (ou garder le flag désactivé) avant de réactiver l’envoi. Les jetons Toolbox ne sont jamais dans la base.

## Documentation

Lot Contact (états manuels, semaines ISO, page Contact, messages Contact/R1/R2, IA, Toolbox, envoi programmé) :
handoff et décisions dans [`tasks/viper_contact_pipeline_handoff/`](tasks/viper_contact_pipeline_handoff/README.md), rapport
final dans [`FINAL_REPORT.md`](tasks/viper_contact_pipeline_handoff/FINAL_REPORT.md). Les en-têtes des modules `src/server/*`
documentent les contrats d’API et les modèles d’exécution.

[`doc/`](doc/README.md) (décisions produit, ADR, runbooks) se rapporte en grande partie à l’ancienne pile FastAPI/PostgreSQL.

## Confidentialité

Ce dépôt est **public**. Aucune donnée réelle de contact ne doit y être commitée : `tasks/**/sources/` et tous les
tableurs/CSV sont ignorés par git, et `scripts/check_private_data.py` (exécuté en CI) échoue si l’un d’eux est
suivi. Seules les fixtures synthétiques (`backend|frontend/tests/fixtures/synthetic/`) sont autorisées.
