# Rapport final d'implementation — Refonte fiche prospect (branche `task/prospect-contact-ux`)

Etat : **implemente et valide techniquement par l'agent S6 ; NON accepte**. L'acceptation est Humaine (voir « Verifications Humaines requises »).

## Resume

La fiche prospect (drawer de Prospection) passe a deux onglets **Profil / Suivi** (D-UX1). Profil : resume compact (nom, role, entreprise, e-mail, telephone, etat de suivi) puis sections en lecture qui s'editent a la demande (Identite, E-mails, Telephones, Emploi). Suivi : suivi de contact, **Notes** (liste dense de faits, ajout rapide), opposition, provenance, historique. Une carte **Score prospect** (anneau 0-100, mot du niveau, resume, detail au clavier, « Voir la note ») est calculee **cote backend** (D-UX2). La carte « Verification de l'emploi » est supprimee comme bloc ; son etat et son action sont un statut secondaire de la section Emploi, donnee et API inchangees (D-UX3). Les notes et le score entrent dans le contexte de l'agent de redaction des e-mails (prompt v3).

## Taches terminees

| Tache | Slice | Resultat |
|---|---|---|
| 00 Orchestration / audit | S0 | audit, ecarts (ni notes ni score ni onglets n'existaient), decisions D-UX1..3 |
| 01 Contrat de scoring | S1 | `ProspectScore{total,summary,band,contributions[]}`, service backend, config, notes backend (migration 0012) |
| 02 Notes | S2 | liste dense, ajout rapide, edition en place, suppression confirmee |
| 03 Profil / coordonnees | S3 | onglets, resume compact, lecture -> edition -> sauvegarde, emploi deplace |
| 04 Carte Score | S4 | `ScoreRing`, `ProspectScoreCard`, detail modal, « Voir la note » |
| 05 Contexte agent | S5 (+ correctif S6) | notes + score dans le prompt, `PROMPT_VERSION` v2 puis v3 |
| 06 Regressions / qualite | S6 | correctif prompt v3, QA, e2e ajoutes, ce rapport |

Cases 01..06 cochees dans `tasks/TODO.md` avec la mention « valide techniquement, pas accepte ».

## Fichiers principaux modifies (par Slice)

Commits : S0 `98578d8`, `979eaf6` · S1 `130db07`, `4ecba88` · S2 `61f07b0`, `a3699b3` · S3 `2ba1e99` · S4 `63b03d5` · S5 `a78a62f` · S6 `f3a7637` + commits S6 suivants.

- **S0** : `tasks/prospect_contact_ux_handoff/**` (handoff local, `tasks/00-orchestrator/JOURNAL.md`), decisions Humaines.
- **S1 (backend)** : `models/prospects.py` (`ProspectNote`), `models/enums.py` (`NoteSourceType`), `migrations/versions/0012_prospect_notes.py`, `repositories/notes.py`, `services/prospect_notes.py`, `services/prospect_score.py`, `services/prospect_editor.py` (score dans la vue), `api/routes/prospects.py` (routes notes, `score`), `core/config.py` (base/seuils), `services/audit.py`, `core/audit_policy.py`, `services/explorer/policy.py`, `services/history.py` ; tests `test_prospect_notes_api.py`, `test_prospect_score.py`, `test_schema_constraints.py`, `test_history.py`, `test_cli.py` ; docs `data-model.md`, `audit-and-provenance.md`, `prospect-editor.md`.
- **S2 (frontend)** : `prospects/ProspectNotes.tsx` (+ test, css), `noteForm.ts`, `api/prospectNotes.ts`, `api/prospects.ts`, `database/tableCatalog.ts`, `test/prospectsApi.ts`, `e2e/prospect-editor.spec.ts` ; docs `design-system.md`, `prospect-editor.md`.
- **S3** : `prospects/ProspectEditor.tsx`, `ProfileSummary.tsx`, `EditorSection.tsx`, `EmploymentSections.tsx`, `AliasList.tsx`, `profileEditing.ts`, `profile-summary.css`, `editor-section.css`, `prospects.css`, tests Prospect*.test.tsx adaptes (onglets), `e2e/accessibility|history|search.spec.ts` ; docs `interface-spec.md`, `design-system.md`, `prospect-editor.md`.
- **S4** : `ui/ScoreRing.tsx` (+ css, test), `prospects/ProspectScoreCard.tsx`, `scoreView.ts`, `prospect-score.css`, `ProspectNotes.tsx` (mise en evidence d'une note), tests `ProspectScore*.test.tsx`, `theme/tokens.test.ts`, `e2e/prospect-editor.spec.ts`, docs.
- **S5** : `services/contact_mail_generation.py`, `services/mail_generation/prompt.py`, `api/routes/contact_messages.py`, `core/config.py` (`contact_mail_max_notes`, `contact_mail_max_score_contributions`), tests `test_mail_generation.py`, `test_contact_mail_generation.py`, `e2e/contact.spec.ts`, docs `contact.md`, `data-model.md`, `decision-log.md`.
- **S6** : `services/mail_generation/prompt.py` (v3 : `ScoreContributionFact.note_rank`, faits numerotes, score omis sans contribution), `services/contact_mail_generation.py` (`_score_facts`), tests `test_mail_generation.py`, `test_contact_mail_generation.py`, `e2e/contact.spec.ts` (version du prompt), `e2e/prospect-editor.spec.ts` (2 scenarios QA, attente du survol du tiroir), docs `contact.md`, `prospect-editor.md`, `data-model.md`, `decision-log.md`, `tasks/TODO.md`, ce rapport.

## Decisions prises pendant l'implementation

Humaines (S0) : **D-UX1** onglets Profil / Suivi ; **D-UX2** score calcule cote backend, contributions manuelles ; **D-UX3** carte « Verification de l'emploi » supprimee, statut secondaire dans Emploi, donnee et API conservees.

Orchestrateur / agents :
- S1 : notes = table `prospect_notes` (hors `version` de l'editeur, API propre, auditee) ; score **jamais persiste**, calcule a la lecture ; base 50, seuils rouge < 40 / jaune < 70 / vert >= 70 configurables par environnement ; total borne 0-100 ; contribution = `score_delta` (-50..50) d'une note, `source_ref` = id de la note ; contrat independant de ces regles (`origin` extensible).
- S2 : les notes s'ecrivent immediatement via leur API (ne salissent pas le formulaire) ; Entree ajoute la note sans enregistrer le prospect ; Ctrl+Entree avec un fait saisi ajoute la note (ne perd pas le fait).
- S3 : sections Profil en lecture, edition a la demande ; une section en erreur s'ouvre toujours en saisie ; les changements non enregistres d'un onglet sont signales sur l'onglet.
- S4 : detail du score en `Modal` (focus piege, Echap ferme le detail seul), niveau dit par un mot (la couleur ne porte pas seule le sens) ; le front ne connait aucun seuil.
- S5 : notes (les 20 plus recentes, 300 car. max) et score (5 plus fortes contributions) dans le prompt, **comme contexte interne non prescriptif** ; instructions : ne jamais citer le score, ne citer qu'un fait professionnel/public, jamais un fait prive.
- S6 (decide par l'orchestrateur) : **prompt v3** — la section « Score prospect » est omise sans contribution (le total de depart n'est pas un signal verifie) ; les faits sont numerotes (`1.`, `2.`...) et une contribution dont la note est listee s'ecrit « +10 : voir fait n°2 » au lieu de repeter le texte ; une contribution dont la note est hors plafond garde son texte.

## Migrations / compatibilite

- **0012** `prospect_notes` (seule migration de la tache). Aucune migration pour le score. `provision-sql-reader` a relancer apres migration (runbook).
- `PROMPT_VERSION` : `contact-mail-fr-2026-10-v3` (v1 -> v2 en S5, v3 en S6). Les e-mails deja generes gardent leur version d'origine.
- Contrat API `GET /prospects/{id}` : champ `score` ajoute (ajout seul). `employment_verified_at`, `verification_state`, KPI, segments, export/import Excel : **aucun fichier de `services/prospection`, import ou export modifie** par la tache (verifie par `git diff --name-only 98578d8..HEAD`), et leurs tests passent.

## Tests executes (resultats reels, 2026-10-04, Windows, Postgres local 5442)

Backend (`backend/`, venv) :
- `ruff check . ../scripts` : All checks passed.
- `ruff format --check . ../scripts` : 250 fichiers deja formates.
- `mypy` : Success, no issues found in 250 source files.
- `pytest` complet : **1384 tests collectes, tous passes** (code de sortie 0). Remarque : un premier passage lance **en meme temps** que les tests frontend a echoue sur `test_export_reads_20k_prospects_in_a_few_statements_whatever_the_statistics` (budget 2 s, mesure 13,6 s sous charge) ; relance seule : vert.
- Cibles du correctif v3 : `test_mail_generation.py` + `test_contact_mail_generation.py` : 82 tests passes.

Frontend (`frontend/`) :
- `npm run lint` : propre ; `npm run typecheck` : propre ; `npm run build` : OK (avertissement habituel de taille de bundle).
- `npm test` (vitest) : **911 tests, 73 fichiers, tous passes** sur machine au repos. **Sensibilite a la charge** : lance en parallele d'une autre tache lourde, 1 a 62 tests echouent par depassement du delai de 5 s (liste differente a chaque fois, ex. `IntegrationCards`, `AiDraft`, `ProspectScore`) ; chaque fichier repasse seul. Ce n'est pas une regression de la tache mais une fragilite de la suite : ne pas lancer vitest pendant pytest/e2e.
- Playwright, chromium, `--workers=2` : **109 passes** (derniere execution complete, 3,3 min). Une execution precedente (108 tests, avant ajout de 2 scenarios) : 107 passes + 1 echec transitoire de `editor screenshots` (`document.scrollWidth` 1461 > 1440 juste apres ouverture : le tiroir glisse encore sous charge). Le test passait seul et 2 fois de plus ; l'assertion est desormais « poll » (`expect.poll`) dans `e2e/prospect-editor.spec.ts`.
- Scenarios e2e ajoutes en S6 : (1) lecture -> edition -> **Ctrl+S**, notes avec impact **+20, -5, 0** donnant 65, detail du score **ouvert a Espace/Entree**, Echap redonne le focus a la carte ; (2) ecrans etroits **768 et 390 px** : pas de debordement horizontal du tiroir, onglets, notes et score atteignables.
- Couverts par les e2e existants (S2..S5, tous verts) : verification de l'emploi -> « Verifie le » dans la liste Prospection ; notes 0/1/12+ avec texte long, liste bornee a 360 px ; ajout, modification, suppression confirmee ; persistance apres rechargement ; Ctrl+Entree enregistre et ouvre le suivant ; Echap ferme ; « Enregistrer et suivant » dans la file filtree ; score 50 -> 75 avec detail et « Voir la note » ; themes clair/sombre a 1440 et 1280 px ; textes longs (nom, entreprise, role, adresse) sans debordement.

## Resultats UX

Captures reelles dans `frontend/test-results/screenshots/` (non versionnees) : `prospect-editor-{to-verify,verified}-{,aliases-,tracking-}{dark,light}-{1440,1280}.png`, `prospect-score-{card,detail}-*.png`, `prospect-editor-notes.png`, `prospect-editor-narrow-*-{768,390}.png`.
Comparees a `visuals/current-profile-layout.png` : l'ancienne fiche etalait plusieurs gros formulaires (Identite, Emploi, carte de verification pleine) et 4 onglets ; la nouvelle montre au premier ecran a 1280 px le resume (nom, role, entreprise, e-mail, telephone, etat), Identite, E-mails, Telephones en lecture sur une ligne chacun, le score et l'emploi, sans scroll pour l'essentiel. Les notes sont une liste d'une ligne de fait + une ligne de meta, defilante a 22 rem, au lieu d'un gros bloc.
A 390 px le pied de tiroir (raccourcis + 4 boutons) occupe environ 170 px sur 800 : lisible, sans debordement, mais dense.

## Points ouverts

1. **Base et seuils du score** (50 ; rouge < 40, jaune < 70, vert >= 70) : valeurs de l'orchestrateur, **a confirmer par le produit** ; configurables seulement par variables d'environnement (`VIPER_PROSPECT_SCORE_*`), pas dans Parametres.
2. **Vocabulaire des sources** de notes (`NoteSourceType`) a valider.
3. **Contributions uniquement manuelles** (`origin="manual"`) ; aucun signal automatique.
4. **Journalisation cote client absente** : les echecs d'ajout/modification/suppression de note ne sont visibles qu'a l'ecran (pas de canal de log client dans le depot).
5. **Verification e-mail/telephone** : seules les sections e-mails/telephones gardent leur etat « Verifie » ; en lecture, la verification d'une ligne reste une action de la section en edition (non revue en profondeur).
6. **Effet reel sur la qualite des e-mails non valide** : tous les tests du prompt utilisent un faux generateur ; aucun appel a un vrai modele. Le prompt v3 est inspectable et teste en contrat, pas evalue en qualite (risque de fait sensible cite, de ton influence par le score).
7. Une execution e2e a montre un clic sur « Modifier : Identite » sans effet apparent juste apres l'ouverture du tiroir (avant la fin du chargement de la fiche entreprise) ; non reproduit apres attente du chargement (3 executions). A surveiller ; non diagnostique plus avant.
8. Fragilite de la suite vitest sous charge (voir Tests) et du test de budget d'export 20k (pytest) sous charge.
9. Tri du detail du score (favorables d'abord) different du tri du prompt (plus forte valeur absolue d'abord) : voulu, a savoir.
10. Pas de capture de navigateur Firefox/WebKit : seul chromium a ete lance, comme demande.

## Risques / suivi recommande

- Les notes (texte libre, possiblement sensibles) partent **telles quelles** chez le fournisseur du modele dans le prompt de redaction : a valider avec le Humain/RGPD avant usage reel.
- Le score n'est pas persiste : aucun historique d'evolution, aucun tri/filtre par score dans Prospection ou les exports (hors perimetre).
- Aucune modification KPI/segments/Excel ; si le score doit y etre expose, prevoir une tache dediee.
- Relancer `provision-sql-reader` apres `alembic upgrade head` pour que la console SQL voie `prospect_notes`.

## Verifications Humaines requises

1. Ouvrir une fiche reelle (donnees de production ou copie) : onglets, resume, edition/enregistrement, verification de l'emploi dans Emploi, notes, score et detail ; avis sur la densite par rapport aux captures d'origine.
2. Confirmer base et seuils du score, et le vocabulaire des sources de notes.
3. Generer des e-mails avec **un vrai modele** (cle OpenAI en Parametres > Connexions) sur 3 a 5 prospects ayant notes et score, et verifier : aucun fait prive, aucune mention du score, pertinence de l'angle.
4. Decider de la tolerance RGPD sur l'envoi des notes au modele.
5. Accepter ou rejeter chaque tache 01..06 (aucune n'est marquee « acceptee »).
