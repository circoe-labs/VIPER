# Refonte import Excel et séquences de contact

Handoff local (origine : document Humain `HANDOFF.md`, reçu le 2026-10-01, aucune file Drive). Branche de travail :
`lucie` (règle `.claude/CLAUDE.md` sur `LUCIE-PC`), qui contient `task/contact-port` (S0-S5 acceptés).

## Mission

Appliquer les décisions métier de `HANDOFF.md` à la pile réellement utilisée, **FastAPI + PostgreSQL (`backend/`) et
React (`frontend/`)**. La DA reste celle du frontend (Neon Command). Principe directeur : l'humain valide la donnée
métier, VIPER structure et pilote, l'IA détecte sans jamais décider.

## Sources

- Règles métier (source de vérité) : `HANDOFF.md` (§3 à §19).
- Contexte et conventions : `tasks/viper_contact_port/README.md` (règles agents, gates, bases de test), `doc/process/*`,
  `doc/adr/`, `doc/design/design-system.md`.
- Analyse d'entrée (orchestrateur, 2026-10-01) : voir « État initial » ci-dessous.

## État initial (analyse S0)

- Sxx est traité partout comme une **semaine ISO** (`imports/normalize.py`, `review.py`, `contact_workflow.py`,
  `frontend/src/lib/isoWeek.ts`) ; `S0` est rejeté (`invalid_week`). Pas d'entité cohorte.
- `contact_tracking` : **une ligne par prospect** (UNIQUE) ; états stockés `neutral/contacted/r1/r2/...` choisis à la
  main ; cadence suggérée +2/+2/+4 semaines.
- `contact_messages` : `UNIQUE(prospect_id, step)` avec étapes Contact/R1/R2 seulement ; **aucun code ne marque un
  message `sent`** (envoi = S7 du portage, non fait).
- Import : feuille choisie par meilleur en-tête (pas forcément la 1ʳᵉ) ; colonnes non mappées gardées en
  `import_row_metadata.legacy_metadata` ; « Mode de contact » déjà opaque (conforme) ; fusion « remplir les vides »,
  valeur différente gardée **en silence** (pas d'alerte) ; `reconcile_batch` écrase `activity_status` /
  `employment_verified_at` et passe les e-mails importés à `verified`/`invalid` selon `Statut_verification`
  (contraire à « validation fonction ≠ validation e-mail ») ; règle P7 « semaine passée → contacté ».
- Aucun concept : cohorte, S0, Défaillant, Erreur sur le mail, Relance terminée, alerte qualité, provenance par champ.
- `BASE CLIENT.xlsx` (local, Bureau, **jamais commité** — dépôt public) : 1 feuille métier `Base client ` de 300
  lignes ; colonne C `A contacter ` : vide 188, `s37` 52, `s39` 50, `s40` 9, `retraité` 1 ; ni S0 ni S41 ; colonnes
  relance/RDV vides ; pas de colonne erreur e-mail ; 6 lignes parasites sans identité.

## Décisions de refonte

Les décisions D1… sont consignées dans `TODO.md` (journal) au fur et à mesure des arbitrages Humains. Elles
**remplacent** P1 et P7 du portage Contact là où elles les contredisent.

## Règles pour tous les agents

Identiques à `tasks/viper_contact_port/README.md` (« Règles pour tous les agents »), avec ces différences :
branche `lucie` ; commits `S<n> <type>(<scope>): …` en français terminés par
`Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` ; le classeur réel ne sert qu'à la recette locale (S6) et
aucune de ses valeurs n'entre dans le code, les tests, la doc ou les commits.
