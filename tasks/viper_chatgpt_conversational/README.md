# VIPER × ChatGPT — interface conversationnelle

- Handoff d'origine : [HANDOFF.md](HANDOFF.md), rédigé contre `main@699ec3b`.
- Readiness (Slice 00) : [READINESS.md](READINESS.md), **READY** le 2026-11-03.
- Branche : `feat/chatgpt-conversational`, créée depuis `main@0339153` (PR #12 fusionnée).
- Rapport en ligne : https://claude.ai/artifact/U5FFAgHj4zJ7X4z4CVMSj2

| Slice | Sujet | Tier QA | Dépend de | État |
|---|---|---|---|---|
| 00 | Readiness PM | docs | — | DONE |
| 01 | Capacités d'agent (extension de `McpToken`) et `viper_whoami` | critical | 00 | à lancer |
| 02 | Lectures conversationnelles MCP | glue | 00 (câblage final : 01) | à lancer |
| 03 | Actions de mission MCP et annotations | critical | 01 | en attente |
| 04 | Découverte : établissements et déclencheur | critical | 00 | à lancer |
| 05 | Skill `viper-use` et routage CIRCOE | docs | 02, 03 (noms d'outils) | à lancer |
| 06 | UI de création de mission (app MCP) | ui | 03 (contrat) | en attente |
| 07 | Brouillons de contact via MCP | critical | 01 | en attente |
| 08 | Intégration et validation finale | release | toutes | en attente |

Les problèmes non bloquants sont consignés dans `Issues/`.
