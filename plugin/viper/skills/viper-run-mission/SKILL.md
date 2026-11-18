---
name: viper-run-mission
description: Exécuter le travail d'une mission VIPER en tant qu'agent (s'identifier, prendre une tâche, travailler, rendre le résultat, se désinscrire) et traiter les données à vérifier. À charger quand on demande « prends la prochaine mission dans Viper », « vas-y », ou à tout agent planifié ou worker.
---

# Exécuter une mission VIPER

Tu **es** l'agent. VIPER ne lance aucun agent à ta place et tu ne « crées » pas d'agent : annoncer « je crée un agent » est faux et ne produit rien. Ce qui compte est la suite d'appels ci-dessous : c'est elle qui rend ton travail visible dans VIPER (agents actifs en direct, journal, résultats).

## 1. T'identifier

`viper_whoami` : ton identité (« Claude prenom #2 ») vient de ta connexion et ne change pas pendant la session. Garde `agent_id`, `capabilities` et `task_types` ; il te faut `tasks.work` pour travailler. Si les outils sont refusés ou absents, dis-le à l'utilisateur et arrête-toi.

## 2. Choisir et prendre une tâche

- Voir ce qui attend : `viper_task_queue` (comptes par type) et `viper_list_missions` (`status: active`).
- Prendre la suivante : `viper_claim_task`. Pour travailler **une mission précise** (« inscris-toi à cette mission ») : `viper_claim_task` avec `mission_id`.
- Rien à prendre : la réponse le dit et indique pourquoi (mission en pause, aucune exécution lancée). Dis-le à l'utilisateur ; ne fabrique pas de travail.
- La tâche ouvre automatiquement ta **session de travail** dans VIPER. Garde `task_id` et `claim_id` : ils accompagnent tous les appels suivants.

La réponse contient tout : le sujet, la règle de la mission (`mission` : consignes, catégorie, skills, sources), le contexte interne en lecture seule, le contrat de sortie (`output_contract`, schéma du résultat) et `objective`.

### Travail spontané : le « Dépôt »

Une personne te demande directement, hors de toute mission, d'ajouter ou de compléter une donnée (« ajoute ce contact », « complète cette société ») : ce n'est pas une mission, mais le travail passe par le **même processus**. `viper_open_deposit` ouvre une tâche dans la mission permanente **Dépôt** (visible dans VIPER > Missions) et te la confie en un seul appel : tu reçois la même réponse que `viper_claim_task` (sujet, contrat de sortie, `task_id`, `claim_id`).

- `task_type` : `find_prospects` (une nouvelle société, sans sujet), `find_employees` (de nouvelles personnes d'une société : `company_id`), `update_company` (`company_id`), `update_employee` (`prospect_id`), `surveil_signals` (`company_id`).
- Ajouter une personne dont la société n'existe pas encore : dépose d'abord `find_prospects` pour la société, puis `find_employees` pour la personne.
- Vérifie les doublons avant (`viper_check_duplicate`, `viper_find_*`) : si la fiche existe, dépose `update_company` / `update_employee` plutôt qu'un doublon.
- Ensuite, étapes 3 à 5 inchangées : travailler, `viper_submit_task_result` (une personne relit), `viper_fail_task` (le dépôt est clos en échec, rien n'est remis en file) ou `viper_release_task` (le dépôt est abandonné).

## 3. Travailler

- Suis les consignes et les skills de la mission, ouvre les sources indiquées.
- **Journalise des faits** avec `viper_log_mission_activity` : recherche faite, source ouverte, observation, vérification, progression, avertissement. Une phrase factuelle, au passé.
- Le bail de la tâche expire : `viper_heartbeat_task` régulièrement sur les tâches longues.
- **Avant de proposer une société, un prospect ou un entrepôt**, vérifie qu'il n'existe pas : `viper_check_duplicate`. Verdict `exists` : mets à jour l'existant (`viper_update_company` / `viper_update_prospect`), pas de doublon. Verdict `possible` : compare le champ `comparison` avant de décider (deux personnes peuvent porter le même nom).
- Pour lire la base, voir `viper-ask-data` (`viper_find_*`, `viper_get_*`).

## 4. Rendre le résultat

- `viper_submit_task_result` avec un résultat conforme à `output_contract`. Rien trouvé : `outcome: not_found` ou `blocked` avec des `notes`, sans données. Mets un court rapport factuel dans `notes` (ce que tu as cherché, ouvert, vérifié, pas trouvé).
- Impossible de faire la tâche : `viper_fail_task` avec un code stable. Tu veux la rendre sans l'échouer : `viper_release_task`.
- Ton résultat est une **proposition** : une personne la valide dans VIPER.

## 5. Te désinscrire

Quand tu as fini (ou que tu t'arrêtes) : `viper_leave_work`. Il rend les tâches que tu tiens et ferme ta session, pour que VIPER sache combien d'agents travaillent en direct. Sans cet appel, le bail expire après 15 minutes et la session après 3 h : ne t'en sers pas comme d'une sortie normale. Plusieurs tâches d'affilée : reprends à l'étape 2, puis un seul `viper_leave_work` à la fin.

## Traiter les données à vérifier (sans tâche de mission)

Pour un agent de vérification, la file de travail est dans la base :

1. `viper_review_queue` sans argument : ce qui reste à vérifier par type. Puis avec `entity` (`company`, `warehouse`, `prospect`) pour la liste ; chaque ligne dit ce qui `missing`.
2. Travaille la fiche, vérifie le doublon (`viper_check_duplicate`), propose la correction avec `viper_update_company` / `viper_update_prospect` (stockée pour validation).
3. Ne modifie pas ce qui est déjà `verified`. Rends compte à l'utilisateur de ce que tu as traité.
