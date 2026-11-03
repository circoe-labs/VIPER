# VIPER × ChatGPT — rapport final (Slice 08)

`scratchpad/…` désigne le dossier de la session d'intégration
(`C:\Users\Clarice\AppData\Local\Temp\claude\204bbd3f90d42ba9\efff5ae9-912e-4992-b4e6-17cdc60b3563\scratchpad`). Ces
fichiers sont temporaires : traces, scripts et sorties de commandes ; ils ne sont pas commités.

Date : 2026-11-04. Branche : `feat/chatgpt-conversational`. Base de la Slice 08 : `9393fe2`, avec les Slices 01, 02,
03, 04, 06 et 07 fusionnées. La Slice 05 a été livrée hors dépôt. Comparaison faite avec `main@0339153`.

## Ce qui est livré, par Slice

| Slice | Livré | Code principal |
|---|---|---|
| 01 Capacités d'agent | `McpToken` gagne `provider`, `mode` et `capabilities` (migration 0025, avec backfill). Capacités effectives = capacités propres ∩ rôle de la personne déléguée ; la vérification refuse par défaut (personne déléguée absente ou inactive → rien). `require` est la seule garde. Ajout de `viper_whoami`. Paramètres › MCP : « Créer un jeton » avec mode et capacités. L'historique affiche « Agent · ChatGPT · pour X ». | `services/agent_capabilities.py`, `api/mcp.py`, `routes/mcp_settings.py`, `settings/McpAgentCreate.tsx` |
| 02 Lectures conversationnelles | 8 outils en lecture seule. Chacun réutilise le service et le modèle de sortie REST de l'écran correspondant. | `api/mcp_conversational.py` |
| 03 Actions de mission | 6 outils : options, créer (`run_now`), modifier, lancer, statut (pause, reprise, annulation), supprimer. Capacités par argument et annotations. Un run garde la règle sous laquelle il a démarré (migration 0027, `mission_runs.config`). | `api/mcp_missions.py`, `services/missions.py`, `agent_payloads.py` |
| 04 Découverte de sites | Une entreprise `find_prospects` peut porter `establishments` et un `trigger` daté. Nouveaux `SignalKind` `facility_*` (migration 0026). L'acceptation crée l'entreprise, ses sites et le signal en une seule transaction, avec leur provenance. La fiche de revue affiche les sites et le déclencheur. | `agent_payloads.py`, `companies.py`, `agents/ReviewDialog.tsx` |
| 05 Skill `viper-use` | Livré hors dépôt (`Downloads/viper-use`). La réconciliation est dans `FINAL_TOOLS.md`. | — |
| 06 Carte de mission | Ressource MCP Apps `ui://viper/mission-card-v1.html` et `_meta` sur `viper_create_mission`. La carte permet de lancer la mission, de la modifier ou de recréer une mission refusée. | `api/mcp_ui.py`, `api/mcp_ui_templates/mission_card.html` |
| 07 Brouillons de contact | `viper_generate_contact_draft` et `viper_update_contact_draft`. L'agent reste l'acteur et ne peut écrire que des brouillons (`agent_draft_only`). Aucune validation, programmation ou envoi. | `api/mcp_contact.py`, `contact_messages.py` |
| 08 Intégration | Correctifs et polish ci-dessous, documentation alignée, validation complète, scénarios MCP, liste finale des outils. | — |

## Commits de la Slice 08

| SHA | Objet |
|---|---|
| `0c50ee5` | **Régression bloquante corrigée.** Le test de Paramètres › MCP cherche `viper_claim_task` par son nom, et non plus en première position. `_type_of` lit `anyOf` : un champ nullable s'affiche avec son type, et non plus comme « objet ». Un test est ajouté. |
| `8dc00f8` | Tests « toutes les capacités sauf celle requise » pour chaque outil de mission et chaque variante d'argument (9 cas). Ils tuent les mutations M1 et M2. Mutation vérifiée : `run_now` sans `missions.run` → test rouge. |
| `5678034` | Découverte : refus d'une URL non http(s), pour le déclencheur et pour un site ; refus `too_old` ; `result_limit` et `period_days` lus dans le snapshot du run. 4 mutations vérifiées, toutes tuées (M6, M8, M9, M10). |
| `d070d26` | `output_schema_version` passe à 2. La doc `agent-missions.md` est corrigée : la version n'était pas stockée sur la tâche. |
| `bf69312` | `ReviewDialog` : `role="group"` sur « Déclencheur ». Le test cherche le bloc par ce rôle. |
| `8bf1441` | Docstring de `agent_capabilities` : un appel peut exiger plusieurs capacités. |
| `8f19d74` | `GET /api/settings/mcp` renvoie `grantable`. « Créer un jeton » ne propose que ce que le rôle permet : un `member` n'est plus refusé (403) à cause de `missions.cancel`. Tests backend et frontend ajoutés. |
| `bb406df` | `doc/architecture/mcp-server.md` : statut (29 outils), annotations, déploiement M3 et questions ouvertes 1 et 2 tranchées. Création de `Issues/s08-integration-followups.md`. |
| `bc97d0e` | `ruff format` sur `mcp_settings.py`, dont mon correctif avait cassé le formatage. |
| `072806c` | `FINAL_TOOLS.md`. |

Tous les points de `POLISH.md` sont traités, sauf la longueur de `viper_get_contact_overview` (Slice 02), qui
dépendait des traces. La trace de la Slice 08 mesure 8,7 Ko pour une base de test presque vide, ce qui ne dit rien
d'une vraie semaine. Le point est reporté dans `Issues/s08-integration-followups.md`.

## Preuves de validation

Commandes lancées une fois sur la branche, depuis le worktree. `import app` pointe bien vers le worktree.

| Contrôle | `main@0339153` | Branche (Slice 08) |
|---|---|---|
| Backend `pytest` (base `viper_s08_test`) | — | **1 845 réussis, 2 ignorés** (classeurs privés, ignorés par conception), 0 échec |
| `ruff check . ../scripts` | 8 (7 E501 dans `contact_dashboard`, 1 RUF015 dans `test_agents_api.py`) | **7** (les mêmes 7 E501 ; le RUF015 a disparu avec le correctif du test) |
| `ruff format --check` | 11 fichiers | **10** fichiers (même liste, moins `agent_payloads.py`, reformaté par une Slice) |
| `mypy` | 12 erreurs dans 8 fichiers (migrations 0020/0023 et tests) | **12**, identiques |
| `check_private_data.py` | — | OK (975 fichiers) |
| Frontend `vitest run` | — | **85 fichiers, 1 059 tests réussis** |
| `tsc -b` | 0 erreur | **0** |
| `eslint .` | 2 erreurs (`LoginPage.test.tsx`, `contactApi.ts`) | **2**, identiques |
| `npm run build` | — | OK |
| e2e Playwright, avec `VIPER_SIGNIN_EMAIL_DOMAINS=circoe.com,example.com` | 55 échecs, 54 réussites, 9 non lancés | **54 échecs, 55 réussites, 9 non lancés** ; échecs ⊂ ceux de `main` |

Lancés avec la configuration par défaut, les e2e échouent presque tous (105 échecs) dès la connexion. Le compte E2E
`@example.com` est refusé par le domaine de connexion introduit par la PR #12, déjà dans `main`. Avec le
contournement, les échecs restants viennent de `main` :

- accessibilité en thèmes clair et sombre (16 au lieu des 24 notés dans `ci-main-red.md`) ;
- specs périmées depuis la PR #12 (navigation, Paramètres, accueil, prospection, éditeur, contact, import).

Le seul écart avec `main` est `design.spec.ts:37`, qui échoue sur `main` et passe sur la branche. Chaque campagne a
tourné sur sa propre base (`viper_s08_e2e`, `viper_s08main_e2e`) et ses propres ports. Celle de la branche a
partiellement coïncidé avec la suite backend. Détail dans `Issues/s08-integration-followups.md`. Les listes d'échecs sont dans
`scratchpad/e2e_main_failed.txt` et `scratchpad/e2e_branch_failed.txt`.

### Migrations

Script : `scratchpad/mig/check.py`. Sortie : `scratchpad/mig/migration_check.txt`.

- **Base neuve** : `upgrade head` (0027, 470 colonnes) → `downgrade 0024` (les colonnes de 0025 et 0027 ont
  disparu) → `upgrade head`. Le schéma est identique au premier passage.
- **Base en 0024 avec des données**, puis passage en head : un jeton CLI sans propriétaire, un jeton OAuth lié à un
  client « ChatGPT » approuvé par un `member`, une mission (`result_limit` 7, `period_days` 90) avec un run `running`
  et 2 tâches, et une note de prospect `funding`. Après la mise à jour :
  - jeton CLI → `other`, `worker`, `[tasks.work, records.read, records.propose]`, sans personne déléguée ;
  - jeton OAuth → `chatgpt`, `interactive`, 12 capacités ; le grant effectif pour le `member` en compte 11
    (sans `missions.cancel`) ;
  - run → `config` NULL (pas de backfill, par conception), et `_task_mission` relit la règle en cours (7 / 90) ;
  - tâches `pending` intactes et note intacte ;
  - une note `facility_opening` est acceptée. Après `downgrade 0024`, elle est repliée en `other` et les tâches
    sont conservées ; un nouvel `upgrade head` passe.

### Scénarios MCP de bout en bout

Les appels sont de vrais JSON-RPC HTTP sur `/mcp`, via `TestClient`, avec les vrais services et la vraie base. Seul
le générateur IA de mails est factice. Script : `scratchpad/scenarios/test_s08_scenarios.py` (lancé dans
`backend/tests` puis retiré, non commité). Traces : `scratchpad/traces/*.json`, résumé dans
`scratchpad/traces/SUMMARY.txt`. **5 scénarios sur 5 réussis.**

- **(a) ChatGPT pour un `member`, via OAuth.** Le scénario couvre :
  - enregistrement → autorisation → approbation par Marie (`member`) → jeton ;
  - `initialize`, `tools/list` (29 outils) ;
  - `viper_whoami` : `interactive`, `chatgpt`, `member`, sans `missions.cancel` ;
  - `viper_search`, `viper_get_dashboard` ;
  - `viper_create_mission` (prospection Normandie, `run_now`) : 1 run, 1 tâche `find_prospects` ;
  - un worker CLI fait le claim (`output_schema_version` 2), le heartbeat, puis le submit d'un entrepôt de
    Honfleur avec un déclencheur `facility_opening` ;
  - `viper_list_pending_reviews` (total ≥ 1, la carte de mission indique `results_pending` = 1) et
    `viper_get_mission` ;
  - Marie accepte en REST. L'entreprise, l'établissement (Honfleur, entrepôt, SIRET) et le signal
    (`facility_opening`, source, `task_result_id`) existent, et `applied.created` est renseigné ;
  - l'audit de `mission.created` donne « Agent · ChatGPT (OAuth) · pour Marie Membre » ; `company.created` est
    attribué à Marie (acceptation humaine) ;
  - 9 appels sont inscrits dans `mcp_calls`.
- **(b) Worker.** `viper_create_mission`, `viper_update_mission`, l'annulation, `viper_delete_mission`,
  `viper_update_contact_draft` et `viper_generate_contact_draft` sont tous refusés en `capability_denied`, avec la
  bonne capacité dans la réponse. Les 6 refus sont gardés dans `mcp_calls` et aucun appel IA n'a lieu. Le worker
  garde claim, heartbeat et release.
- **(c) Rôles.** Le `member` crée une mission, la met en pause et la reprend, mais l'annulation et la suppression
  sont refusées (`missions.cancel`). Le `manager` annule et supprime.
- **(d) Contact.** `viper_get_contact_overview` (8,7 Ko), `viper_get_prospect_messages`, génération (fausse IA)
  puis modification d'un brouillon (révision 1 → 2). Une personne valide en REST. Ensuite, la modification et la
  régénération par l'agent sont refusées en `agent_draft_only` ; le message ne change pas et aucun second appel IA
  n'a lieu.
- **(e) Annotations.** `destructiveHint: true` est déclaré exactement sur `viper_set_mission_status` et
  `viper_delete_mission`. 14 outils sont en lecture seule. **8 outils n'ont pas d'annotations** (tâches worker et
  `viper_update_*`). Les valeurs par défaut de MCP les rendent implicitement destructifs : ce n'est pas une
  régression de la branche, mais c'est consigné dans Issues.

## Régressions

- **Introduite par la branche et corrigée** : le test de Paramètres › MCP (ordre des outils, Slice 01), qui était
  bloquant.
- **Introduite par mon propre correctif et corrigée** : le formatage ruff de `mcp_settings.py` (`bc97d0e`).
- Aucune autre régression : les comptes de lint, de types et d'e2e ne dépassent pas ceux de `main`. Voir le tableau.

## Issues restantes

- `Issues/s08-integration-followups.md` (nouveau) :
  - outils sans annotations ;
  - e2e impossible avec la configuration par défaut depuis la PR #12 (domaine de connexion) ;
  - taille de `viper_get_contact_overview`.
- `Issues/s03-cancel-does-not-stop-tasks.md` : annuler ou mettre en pause une mission ne ferme pas ses tâches
  déjà en file. Problème antérieur à la tâche ; à décider, car il devient visible depuis ChatGPT.
- `Issues/s01-authorization-followups.md` : la révocation d'un agent n'est pas protégée par rôle (antérieur à la
  tâche, sécurité). Organisations non renseignées. `tools/list` non filtré.
- `Issues/s04-discovery-followups.md` : nouveau site d'une entreprise connue, établissement principal,
  dédoublonnage dépendant de l'ordre.
- `Issues/s07-contact-followups.md` : appel IA dans la transaction MCP, rétention du contenu dans `mcp_calls`.
- `Issues/bearer-token-rotation.md` et `Issues/ci-main-red.md` : inchangés.

## Ce que seul un humain peut vérifier dans ChatGPT

1. **Connexion OAuth réelle** depuis ChatGPT (mode développeur) vers l'instance déployée. Vérifier que Caddy
   transmet `/.well-known/*`, `/oauth/*` et `/mcp`, puis que l'approbation se fait sur `/autoriser` avec un compte
   `member`, puis un compte `manager`.
2. **Routage** : sur « nouveaux entrepôts en Normandie », ChatGPT choisit bien VIPER (skill `viper-use` et snippet
   de routage CIRCOE mis à jour avec `FINAL_TOOLS.md`), appelle d'abord `viper_whoami` et crée la mission sans
   confirmation inutile.
3. **Carte de mission** : ChatGPT affiche le gabarit `ui://viper/mission-card-v1.html`. Thème clair et sombre,
   « Lancer maintenant », « Modifier les paramètres », et l'affichage d'un refus (`capability_denied` pour un
   agent sans `missions.run`).
4. **Confirmations de l'hôte** : ChatGPT demande une confirmation pour l'annulation et la suppression. Voir ce qu'il
   fait pour une pause (annotée destructive) et pour les outils sans annotations.
5. **Brouillon de contact** : la génération avec le vrai modèle OpenAI configuré, sa durée (transaction ouverte
   jusqu'à 60 s, voir l'issue S07), puis l'affichage « Agent · ChatGPT · pour … » dans l'historique du prospect.
6. **Volume** : la longueur réelle de `viper_get_contact_overview` sur une vraie semaine, et la qualité des réponses
   de ChatGPT sur les comptages (« combien de prospects… »).
7. **Révocation** : « Révoquer » dans Paramètres › MCP coupe immédiatement le connecteur ChatGPT.
