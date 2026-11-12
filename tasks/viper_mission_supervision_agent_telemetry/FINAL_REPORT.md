# Rapport final — Supervision des missions et télémétrie des agents

## Résumé

Branche `task/viper_mission_supervision_agent_telemetry` (depuis `main` @ `dab3314`, non poussée), Slices S0 à S10.
La page Mission devient une console de supervision : une bande « en direct » (agents actifs, dernière activité,
progression, relectures en attente, avertissements) et quatre onglets — **Vue d'ensemble**, **Activité** (sessions
d'agents + journal factuel), **Résultats** (file de relecture, dialogue de relecture refondu) et **Statistiques**.
Côté agents : session ouverte automatiquement au claim, journal d'activité append-only, expiration après 3 h sans
activité, confiance et dates de source par élément de preuve, outils MCP `viper_log_mission_activity`,
`viper_end_mission_session`, `viper_get_mission_session`. Un résultat n'est toujours appliqué que par une personne.

## Slices et commits (`git log --oneline main..HEAD`)

| Slice | Commits |
| --- | --- |
| S0 — préparation | `ceb53a4` import du handoff et audit · `2af625c` Task Types écartés par l'Humain |
| S1 — contrat | `c63830f` `doc/architecture/mission-telemetry.md` |
| S2 — preuves | `4bb4635` confiance par élément, dates de source |
| S3 — persistance | `e24e512` migration `0038`, `mission_telemetry`, balayage de 3 h |
| S4 — outils MCP | `6348743` outils, limite 120/min, consignes au claim · `ca418bc` correction du journal |
| S5 — API de lecture | `e0e644b` overview, sessions, activity, results, statistics ; fin de run dans le scheduler |
| S6 — coque à onglets | `1b3bdba` |
| S7 — Activité | `9dd9037` |
| S9 — Statistiques | `7545a79` |
| S8 — Résultats et relecture | `623ef26` |
| S10 — intégration | `696acb7` e2e + a11y, tests de concurrence / expiration / journaux, politique de l'explorateur, vocabulaire partagé, correction a11y, `keepPreviousData` · commit suivant : docs, `Issues/`, rapport |

## Tests et validateurs : branche contre `main` (même machine, bases dédiées, worktree propre de `main`)

| Gate | `main` | branche |
| --- | --- | --- |
| pytest complet | 8 failed, 1965 passed, 2 skipped | **8 failed, 2067 passed, 2 skipped** (+102) |
| vitest (`npm test`) | 13 failed, 1135 passed | **13 failed, 1214 passed** (+79) |
| Playwright complet | 66 failed, 47 passed, 9 non lancés | **65 failed, 49 passed**, 9 non lancés (dont le nouveau spec, vert) |
| `scripts/check_private_data.py` | — | OK (1165 fichiers) |
| `npm run typecheck`, `npm run build` | — | OK |
| ruff check / mypy / eslint | 11 / 33 / 33 erreurs | 10 / 33 / 31 erreurs (aucune nouvelle ; fichiers neufs propres) |
| ruff format --check | 14 fichiers | mêmes fichiers (aucun nouveau) |

Les ensembles d'échecs sont **identiques test par test** à ceux de `main` (backend : audit `NOT_AUDITED_TABLES`,
trigger `set_updated_at` et index de FK des entrepôts, message d'une contrainte `companies`, planification 20 k
prospects, allowlist `/api/auth/signup` ; frontend : agenda, companies, imports, prospection, AppShell, couleurs
brutes de `prospection/overview.css` et `warehouses/warehouses.css` ; Playwright : navigation de la coque, Prospection,
Contacts, imports, sociétés… dérivés de l'interface). Aucun échec ne touche aux missions.

**Régression de la branche, trouvée et corrigée.** `test_every_orm_table_is_explicitly_exposed_or_withheld` échouait
déjà sur `main` (entrepôts) ; sur la branche il listait en plus `mission_agent_sessions` et `mission_agent_logs`
(non classées depuis S3). Elles sont ajoutées à `UNEXPOSED_TABLES` ; il ne reste que les deux tables d'entrepôts.

**Défaut d'accessibilité réel (S9), corrigé** : `definition-list` (un `<p>` dans le `<dl>` des KPI) — le conseil est
maintenant un `<dd>`.

## Scénario de bout en bout (Playwright, `frontend/e2e/mission-supervision.spec.ts`)

Création de la mission (`run_now`, 2 sociétés) et d'un jeton agent par l'API ; l'agent est un client JSON-RPC scripté
sur le vrai `/mcp` : 2 claims (bloc `telemetry`), 2 journaux (dont une source), heartbeat, 2 soumissions, fin de
session. Le navigateur vérifie : état vide honnête, journal + lien source + « En cours », file de résultats (2 cartes),
acceptation (aucun champ de motif), rejet (motif absent, puis focalisé et obligatoire après « Rejeter »), taux
d'acceptation 50 % dans Statistiques, Vue d'ensemble. **axe (WCAG 2 A/AA, 2.1 A/AA)** sur les 4 onglets, le dialogue de
relecture et son état de rejet : 0 violation (aucune non bloquante non plus). Ce que le test ne prouve pas : un vrai
modèle de langage ; l'agent est scripté.

Lancer ce spec seul : base dédiée recréée avant chaque run (voir `Issues/02`), `VIPER_E2E_DATABASE_URL` vers une base
`*_e2e`, `npx playwright test e2e/mission-supervision.spec.ts --project=chromium`.

## Durcissement (`backend/tests/test_mission_supervision_hardening.py`)

- 4 agents × 3 claims concurrents (threads, vrais commits) sur un run de 12 tâches : chaque tâche prise une seule
  fois, une session active distincte par agent.
- Expiration de 3 h par la passe du scheduler : seule la session silencieuse expire (`ended_at = last_seen_at + 3 h`,
  un log `warning`), passe idempotente, tâche et bail non touchés, retour de l'agent = nouvelle session.
- Aucun message d'agent ni jeton dans le journal applicatif ni dans les refus (3 refus forgés).
- Isolation par organisation reconfirmée : 5 routes de lecture en 404 hors organisation (`test_mission_supervision.py`),
  `list_logs` / `list_sessions` filtrés par organisation, outils MCP sans identifiant de session ni d'agent en paramètre
  (tests S4). **Lacune préexistante** : la file de claim n'est pas filtrée par organisation (`Issues/01`).
- Pause / annulation / suppression de mission : déjà couverts (`test_mission_stop.py`, `test_mission_telemetry.py`).
- Migration : aller-retour `0038` (`test_migrations.py`) vert ; base E2E reconstruite de zéro jusqu'à `head`.

## Documentation mise à jour

`doc/architecture/mission-telemetry.md` (statut + §13 comportement opérateur), `missions.md` §7b (page livrée),
`agent-missions.md` (preuves livrées), `mcp-server.md` §3.9 (déjà conforme), `doc/process/runbook-production.md`
(note de version : migration `0038`, scheduler dans le process API, pas de purge). `LOG.md` : une section par Slice.

## Implémentations canoniques réutilisées

`McpToken` (identité), `agent_missions` (claim, bail, heartbeat, submit, `_claimed`), `build_proposal` et la
relecture humaine existante, `MissionScheduler.run_once`, `unit_of_work` / audit, la pagination par curseur de
l'historique, `ui/Tabs`, `Badge`, `Dialog`, le graphique maison de `ContactChart` (aucune bibliothèque ajoutée),
`@axe-core/playwright` et les helpers `e2e/data.ts` / `session.ts`.

## Nettoyages

Libellés FR des statuts / types d'événement regroupés dans `frontend/src/missions/vocabulary.ts` (textes inchangés) ;
`keepPreviousData` sur les statistiques (« Mise à jour des chiffres… ») ; `playwright.config.ts` autorise le domaine
`example.com` du compte E2E synthétique (sinon HTTP 403 à la connexion). Le reste est consigné dans `Issues/` (non
bloquant, jamais une régression).

## Risques résiduels

- Aucune purge de rétention des sessions et journaux (borné à 120 écritures/min/jeton).
- Limite de débit « molle » sous concurrence (deux écritures simultanées peuvent passer à 119).
- Journaux visibles, abrégés, dans l'historique des appels MCP (filtré par organisation).
- Barres de jours UTC ; bande en direct qui n'interroge que lorsque l'onglet du navigateur est visible.
- Gates rouges préexistantes sur `main` (voir tableau) : non traitées ici.
- Le `downgrade base` du setup E2E échoue si la base contient des tâches de mission : recréer la base entre deux runs.

## Vérifications Humaines requises

1. **Compréhension UX de la supervision** par une personne qui ne connaît pas la page : voit-elle quels agents
   travaillent, comprend-elle « Expirée », les avertissements et la file de relecture ? (non vérifiable par machine.)
2. **Conformité d'un vrai agent LLM** aux consignes de télémétrie (faits seulement, une entrée par source, français,
   rapport de recherche dans `notes`) : à relire sur de vraies exécutions ; seule une trace scriptée existe.
3. **Migration `0038` en production** : sauvegarde, `alembic upgrade head`, `provision-sql-reader`, puis un claim
   de test et un coup d'œil à l'onglet Activité (runbook de production).
4. Choix produit en suspens : harmoniser « Validé/Rejeté » et « Acceptés/Refusés » ; filtrer la file de claim par
   organisation avant d'ouvrir à une seconde organisation.
