# Slice 02 — Lectures conversationnelles MCP

Tier QA : **glue**. Référence : HANDOFF §8.2 à §8.6.

## But

Exposer en MCP les modèles de lecture canoniques existants, sans SQL générique.

## Correspondance outils → services existants

| Outil | Source |
|---|---|
| `viper_search` | `routes/search.py` → service de recherche globale (prospects, entreprises, établissements) |
| `viper_get_dashboard` | `routes/home.py` `home_dashboard` |
| `viper_get_prospection_metrics` | `routes/prospection.py` `overview` + `counters` (filtres : segment, période d'ajout) |
| `viper_list_missions` / `viper_get_mission` | `services/missions.list_cards`, `detail` |
| `viper_list_pending_reviews` | `services/missions.pending_proposals` (+ `agent_review.get_review` pour le résumé) |
| `viper_get_contact_overview` | `routes/contact.py` `dashboard` + `scheduling` |
| `viper_get_prospect_messages` | `routes/contact_messages.py` `list_messages` / `get_message` |

« Nouveaux prospects sur N jours » : si `counters` ne couvre pas cette question, ajouter une fonction de service
dédiée (par exemple `created_since`) plutôt qu'une requête dans le handler MCP.

## Règles

- Réutiliser les schémas de sortie Pydantic des routes REST. Pas de nouvelle forme de données quand une forme
  existe déjà.
- Chaque outil déclare sa capacité : `records.read`, `dashboard.read`, `missions.read`, `reviews.read` ou
  `contact.read`. Tant que la Slice 01 n'est pas fusionnée, passer par une garde provisoire du même nom.
- Ajouter `annotations: {readOnlyHint: true, destructiveHint: false, openWorldHint: false}`.
- Rédiger les descriptions d'outils en anglais : courtes, et qui disent quand utiliser l'outil.

## Validation

Un test par outil sur une base de test (`tests/builders.py`), qui vérifie la forme de la réponse et au moins un
chiffre. Une trace MCP réelle : `tools/list`, puis un `tools/call`.
