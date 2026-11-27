---
name: viper-create-mission
description: Créer ou modifier une mission VIPER avec l'utilisateur (outils viper_mission_options, viper_create_mission, viper_update_mission, viper_run_mission). À charger quand l'utilisateur veut qu'un agent cherche, enrichisse ou vérifie des sociétés/prospects de façon ponctuelle ou récurrente.
---

# Créer une mission VIPER

Une mission est une **règle** : à chaque exécution, VIPER en tire des tâches que des agents viennent prendre, en parallèle. Ton rôle ici : comprendre le besoin, poser les bonnes questions, puis créer la mission avec les bons skills et les bonnes sources de la bibliothèque VIPER. Tu n'exécutes pas la mission toi-même (voir `viper-run-mission`).

## 1. Comprendre le besoin

Déduis ce qui est **clair** dans la demande (« toutes les semaines » = hebdomadaire ; « sur Lyon » = restriction géographique). Pour le reste, **pose la question** : ne devine pas. Groupe tes questions en un seul message, 3 maximum, en priorité :

- **Objectif** : quel résultat, pour qui (sociétés à découvrir, personnes à trouver chez des sociétés données, fiches à vérifier ou enrichir, signaux/actualités) ?
- **Nombre de tâches** : combien d'éléments voulus par exécution ? Une tâche = un élément trouvé (société, entrepôt, prospect).
- **Zone / périmètre** : restriction géographique, taille ou type de société, secteur, exclusions ?
- **Rythme** : ponctuelle ou récurrente (tous les combien, jusqu'à quand ou combien de fois) ? Lancer une première exécution tout de suite ?

## 2. Préparer avec VIPER

1. `viper_mission_options` : types et résultats possibles (seuls ceux `executable` marchent), unités de récurrence, nombre de tâches maximal, agents assignables, et la **bibliothèque** : `categories` (avec prompt général, skills et sources par défaut), `skills`, `sources` (filtrables avec `source_search`).
2. Choisis la **catégorie** qui colle au besoin : elle apporte son prompt, ses skills et ses sources. Ne surcharge `skill_ids` / `source_ids` que si le besoin le justifie ; sinon laisse-les hériter de la catégorie.
3. Ajoute des skills ou sources précis quand ils servent le besoin (ex. une source spécialisée dans le secteur demandé), avec leurs ids tirés de la bibliothèque. Dis à l'utilisateur lesquels tu retiens et pourquoi, en une phrase.
4. Missions sur des cibles existantes (enrichir, vérifier) : trouve-les avec `viper_find_companies` / `viper_find_prospects` / `viper_search` (ou `viper_mission_options` avec `target_kind` et `target_search`) et passe leurs ids dans `targets`. Pour une découverte, pas de cible.
5. Évite le doublon : `viper_list_missions` (filtres `status`, `type`) pour voir si une mission équivalente existe déjà.

## 3. Créer

`viper_create_mission` avec au minimum `name` ; puis selon le besoin : `category_id` (ou `type`), `prompt` (consignes précises : critères, exclusions, ce qu'on attend en retour), `geography`, `result_kind`, `task_count`, `is_recurring` + `interval_count` / `interval_unit`, `end_kind` / `ends_at` / `max_runs`, `targets`, `skill_ids`, `source_ids`, `run_now`.

Exemple : « chaque lundi, trouve 20 entrepôts logistiques en Auvergne-Rhône-Alpes »
→ catégorie de découverte, `geography: "Auvergne-Rhône-Alpes"`, `task_count: 20`, `is_recurring: true`, `interval_count: 1`, `interval_unit` en semaines, `prompt` qui précise le type d'entrepôt et les exclusions (valeurs exactes dans `viper_mission_options`).

`task_count` crée autant de tâches dans **une seule** mission (500 au plus) : « trouve-moi 50 prospects chez <société> » → une mission « Trouver des prospects chez <société> », `result_kind: "prospects"`, la société dans `targets`, `task_count: 50`. Jamais 50 missions. Avec plusieurs sociétés liées, le total est réparti entre elles. Pour les missions qui mettent à jour ou surveillent des fiches liées, il y a une tâche par fiche et `task_count` est ignoré.

Après création, résume en deux ou trois lignes ce qui a été créé (nom, rythme, nombre de tâches, skills/sources) et propose de la lancer (`viper_run_mission`) si ce n'est pas fait. Modifier : `viper_update_mission` (n'envoie que les champs qui changent). Pause / reprise : `viper_set_mission_status`. Annuler ou supprimer : **confirmer avant**.

## 4. Et ensuite ?

Si l'utilisateur veut qu'un agent travaille la mission maintenant, c'est la situation `viper-run-mission` (charge ce skill) : une mission créée n'est pas exécutée tant que des agents n'ont pas pris ses tâches.
