# Journal Task 00 — audit initial (2026-10-03, agent 0)

Audit en lecture seule de `backend/` + `frontend/` (branche task/prospect-contact-ux, depuis main propre ; le WIP
local de l'Humain est dans `git stash` « pre-task/prospect-contact-ux WIP »).

## Écarts majeurs avec les hypothèses du handoff
- Pas d'onglets Profil/Suivi : la fiche est un `Drawer size="xl"` à 2 colonnes (`frontend/src/prospects/ProspectEditor.tsx:328-375`).
  Principale : Identité, Emploi, Vérification de l'emploi, E-mails, Téléphones. Latérale : Opposition, Suivi de contact, Entreprise, Provenance, Historique.
- **Aucune carte/table/API « Notes »** : aucun modèle, migration (dernière = 0011), schéma, route, type TS. Les `notes` existantes sont celles de `prospect_sources`.
- **Aucun score** existant (les « score » du dépôt = similarité d'import). Pas de primitive anneau/jauge dans `ui/`.
- Second écran : Workbench Contact (`contact/TrackingPanel.tsx`, `contact/ProspectSheet.tsx` lecture seule).

## Vérification de l'emploi (risque de suppression)
Donnée `Prospect.employment_verified_at` (+ `verification_state`, `employment_imported_unverified`). Consommée par segments/KPI
(`services/prospection/segments.py`, `query.py`), liste Prospection, export/import Excel, changement d'entreprise (reset), historique, tests, ADR 0014/0019.
=> Retirer seulement la carte (UI) et conserver donnée + contrat API ; statut secondaire dans la zone Emploi.

## Contexte agent de rédaction
`services/contact_mail_generation.py:load_context` → `mail_generation/prompt.py` (`MailContext`, `build_input`, `build_instructions`).
`PROMPT_VERSION` à incrémenter (assertée dans `tests/test_mail_generation.py:70`). **Contradiction** : `prompt.py:13` et `doc/features/contact.md:~258`
excluent les notes internes du prompt ; à réécrire si les notes y entrent.

## Contraintes de mise en œuvre
- Nouvelle table : migration 0012, import dans `models/__init__.py`, classement `services/audit.py` (AUDITED/NOT_AUDITED), `explorer/policy.py`, `tableCatalog.ts`, `history.py`, `prospecting_reset.py`, `test_migrations.py`.
- Onglets : casseraient les sélecteurs e2e/vitest par `region` (« Suivi de contact », « Vérification de l'emploi ») ; raccourcis Ctrl+S / Ctrl+Entrée / Échap à préserver.
- Tests : `ruff`, `mypy`, `pytest` ; `npm run lint|typecheck|test|build|e2e`. Captures e2e 2 thèmes, 1440/1280 px.
- Docs : prospect-editor.md, data-model.md, contact.md, interface-spec.md, design-system.md, decision-log.md, audit-and-provenance.md.

## Décisions/points à trancher par l'Humain avant Task 01-02
Voir message de l'orchestrateur : (1) onglets vs disposition actuelle, (2) notes = nouvelle table `prospect_notes`, (3) score : persisté vs calculé, base, seuils, source des contributions.

## Décisions Humaines (2026-10-03)
- D-UX1 : introduire des onglets **Profil / Suivi** dans le drawer (`ui/Tabs`) ; sélecteurs e2e/vitest à adapter.
- D-UX2 : score **calculé côté backend**, contributions **manuelles**. Orchestrateur : base 50, seuils rouge <40 / jaune <70 / vert ≥70,
  configurables (settings), total borné 0-100 par le service. Contribution = `score_delta` optionnel saisi sur une note (source_ref = note) ;
  contrat `ProspectScore{total,summary,band,contributions[]}` indépendant de ces règles.
- D-UX3 : carte « Vérification de l'emploi » supprimée ; état + action en statut secondaire dans la carte Emploi ; donnée et API conservées.
- Ordre : S1 (01 + socle notes backend) → S2 (02 notes UI) → S3 (03 profil + onglets) → S4 (04 score UI) → S5 (05 agent) → S6 (06).
