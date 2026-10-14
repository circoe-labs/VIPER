# TODO — Refonte fiche prospect

## Contexte

Cette refonte vise la fiche contact/prospect montree dans les deux captures de reference. Les problemes prioritaires sont la lisibilite des notes, la densite du Profil et l'absence d'un scoring prospect explicable.

## Regles globales

- Ne pas inventer l'algorithme metier du score : stabiliser le contrat et rendre les parametres configurables.
- Ne pas supprimer la verification d'emploi avant d'avoir identifie ses usages.
- En mode consultation, privilegier la lecture ; l'edition reste accessible mais ne doit pas dominer visuellement.
- Reutiliser le design system et les composants existants.
- Pour toute tache de code, charger `/caveman` et `/coding-guideline` depuis `~/ai/skills/`.
- Ajouter ou mettre a jour les tests au fil de chaque tache.
- Documenter toute divergence necessaire par rapport a ce handoff.

## Ordre des taches

- [x] 00 — Orchestration et audit initial
- [x] 01 — Contrat de scoring prospect
- [x] 02 — Refonte de l'affichage des notes
- [x] 03 — Resume compact du profil et coordonnees
- [x] 04 — Carte Score prospect et detail des contributions
- [x] 05 — Exposition notes + score au contexte de l'agent de redaction
- [x] 06 — Regressions, etats limites et qualite UX

> S6 (2026-10-04) : les cases 01 a 06 signifient « implemente et valide techniquement » (tests, e2e, captures reelles),
> **pas accepte** : l'acceptation reste Humaine. Voir `FINAL_REPORT.md` (points ouverts, verifications Humaines).

## Comment choisir la prochaine tache

Commencer par la premiere tache non cochee. Ne passer a la suivante qu'apres validation des criteres d'acceptation de la tache courante. Si l'audit revele une dependance critique, modifier ce plan explicitement plutot que de contourner silencieusement le probleme.

## Rapport final

A la fin, produire un rapport base sur `templates/final-implementation-report-template.md` avec : fichiers modifies, decisions prises, tests executes, points encore ouverts et eventuelles migrations.

## Amendement orchestrateur (audit Task 00)

Notes (table, API) et score n'existent pas : Task 02 inclut la création du socle notes (migration 0012, API, audit) ; Task 01 définit le contrat score côté backend. Voir `tasks/00-orchestrator/JOURNAL.md`. Ordre inchangé, en attente des décisions Humaines.
