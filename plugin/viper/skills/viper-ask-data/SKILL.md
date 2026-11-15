---
name: viper-ask-data
description: Répondre aux questions sur la base VIPER (chiffres, listes, vérification, doublons) avec les outils viper_find_*, viper_get_*, viper_review_queue, viper_check_duplicate, et illustrer par des graphiques. À charger pour « combien de nouveaux clients / prospects / mails / rendez-vous », « quels entrepôts n'ont pas de société », « qu'est-ce qui est à vérifier », « est-ce que X existe ».
---

# Interroger la base VIPER

Lecture seule. Tu réponds avec des chiffres **tirés des outils**, jamais de mémoire, et tu appuies le discours avec un **graphique**.

## Les outils, par besoin

**Chiffres et vue d'ensemble**
- `viper_get_dashboard` : « où en est-on » (segments, qualité des données, contacts et rendez-vous du mois, envois de la semaine).
- `viper_get_prospection_metrics` : compteurs par segment ; `added_within_days: 7` = nouveaux prospects cette semaine ; `segment` pour en isoler un.
- `viper_get_contact_overview` (`week: "2026-W46"`) : mails à envoyer / envoyés / en retard, brouillons à valider.
- `viper_list_calendly_appointments` : rendez-vous pris (`days_back`, `days_ahead`).
- `viper_list_missions`, `viper_get_mission`, `viper_list_pending_reviews` : missions et ce qui attend une validation.

**Chercher, filtrer, croiser** (filtres combinés en ET, une page à la fois : `limit` / `offset`, lis `total`)
- `viper_find_companies` : `search`, `status`, `missing`, `has` / `lacks`, `company_kind`, `segment`, `postal_codes`, `cities`, `min_prospects` / `max_prospects`, dates.
- `viper_find_warehouses` : mêmes familles + propriétaire (`company_ids`, `company_names`, `without_company: true`), `category`, `to_contact`.
- `viper_find_prospects` : `search`, propriétaire (`company_ids`, `company_names`, `without_company`), `status`, `segment`, `reachable`, dates.
- `viper_search` : résoudre un nom en ids. `viper_get_company`, `viper_get_prospect`, `viper_get_warehouse`, `viper_get_prospect_messages` : une fiche complète.

**Vérification** : `status` vaut `verified`, `usable` ou `incomplete`, ou `to_verify` (= pas encore vérifié) ; chaque ligne dit ce qui `missing`. `viper_review_queue` sans argument donne le compte par type ; avec `entity`, la liste.

**Doublons** : `viper_check_duplicate` (`entity` = company / prospect / warehouse). Verdict `exists` / `probable` / `possible` / `none`, et pour chaque candidat les raisons et une comparaison champ par champ.

## Exemples

- « Combien de mails envoyés cette semaine ? » → `viper_get_contact_overview` (semaine courante), lis les envoyés. Graphique : barres par étape (Contact, R1, R2…).
- « Combien de nouveaux prospects cette semaine ? » → `viper_get_prospection_metrics` avec `added_within_days: 7` ; compare avec la semaine précédente si la question s'y prête.
- « Tous les employés de Alpha et Beta » → `viper_find_prospects` avec `company_names: ["Alpha", "Beta"]` ; vérifie `resolved_companies` (les bonnes sociétés ont-elles été trouvées ?).
- « Les entrepôts sans société » → `viper_find_warehouses` avec `without_company: true`.
- « Les entrepôts de Alpha ou Beta sans code postal » → `viper_find_warehouses` avec `company_names: ["Alpha", "Beta"]` et `lacks: ["postal_code"]`.
- « Qu'est-ce qui reste à vérifier ? » → `viper_review_queue` sans argument, puis avec `entity`.
- « Est-ce que Jean Dupont chez Acme existe déjà ? » → `viper_check_duplicate` avec `entity: "prospect"`, le prénom, le nom, la société et l'e-mail si tu les as.

## Répondre

1. Commence par la phrase qui contient **le chiffre** (« 42 nouveaux prospects cette semaine, contre 31 la semaine dernière »).
2. Ajoute **un graphique** qui porte ce discours (évolution dans le temps, répartition par statut ou segment, comparaison de semaines), avec l'outil de visualisation que ton interface propose (artefact, graphique, image). À défaut, un tableau court. Un message clair, pas de mur de texte.
3. Dis ce que tu as filtré et sur quel périmètre (période, statut), pour qu'on sache ce que le chiffre veut dire. Si un résultat est paginé ou tronqué, annonce-le.
4. Ne devine pas un chiffre que les outils ne donnent pas : dis ce qui manque.
