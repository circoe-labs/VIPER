# TODO — Refonte import Excel et séquences de contact

Lire `README.md` puis `HANDOFF.md` avant toute Slice. Chaque Slice = un agent d'implémentation, puis une revue QA
indépendante, puis la vérification de l'orchestrateur. Gate de fin de Slice :
`backend/.venv/Scripts/python.exe scripts/verify.py` (`--e2e` pour les Slices UI), jamais deux gates en parallèle.

## Décisions (2026-10-01)

Humain (réponses de Lucie) :

- **D1 — Cadence par actions réelles.** Le niveau (Contact, R1, R2, …) = nombre de messages **réellement envoyés**
  dans la séquence courante. Une relance prévue mais non envoyée ne fait rien avancer. Rythme : une semaine entre deux
  envois — la prochaine action devient due la semaine calendaire qui suit le dernier envoi (lundi, heure métier) ; le
  Contact est dû à la date réelle de la cohorte. Plus de cadence +2/+2/+4, plus d'états `r1`/`r2` stockés.
- **D2 — Relance terminée.** Nombre maximal de relances réglable dans Paramètres, **4 par défaut** : après l'envoi de
  R<max>, le prospect est en « Relance terminée » (dérivé, sorti des actions automatiques, toujours contactable).
- **D3 — Envois.** À l'import, une cohorte dont la date est passée enregistre le Contact comme envoyé à cette date
  (source `import`). Toute autre relance se déclare par l'action humaine « Marquer comme envoyé » (date modifiable,
  défaut maintenant). Le futur worker (S7 du portage) marquera ses propres envois.
- **D4 — Défaillant à l'import.** Case « Fichier vérifié humainement » dans la revue d'import, **décochée par défaut** ;
  cochée, les lignes sans Sxx valide deviennent Défaillant (acteur : l'humain qui valide l'import) et l'aperçu annonce
  leur nombre avant validation. L'IA ne pose jamais Défaillant.

Orchestrateur (défauts appliqués, à contester par l'Humain) :

- **D5 — Cohorte.** Entité `cohorts` : code `S<n>` normalisé (casse/espaces), date réelle saisie par l'humain, jamais
  déduite d'une semaine ISO (S39 = 28/09/2026 ≠ semaine ISO 39). `S0` est une cohorte spéciale hors campagne. Codes
  inconnus à l'import : date demandée dans la revue d'import (ou créée dans Paramètres). Code unique (risque : réemploi
  de S37 l'an prochain → l'humain renomme l'ancienne).
- **D6 — Séquence.** Table `contact_sequences` (prospect, cohorte, ouverte/fermée, motif de fin). Changer le Sxx
  (action humaine) ferme la séquence courante et en ouvre une nouvelle : compteur à 0, historique conservé. Les
  messages se rattachent à une séquence avec un rang 0..n (Contact = 0) au lieu de `UNIQUE(prospect, step)`.
- **D7 — États.** Validation métier = cohorte courante (Sxx en campagne, S0 hors campagne, aucune = non validé).
  État commercial stocké, humain uniquement : en séquence (défaut), réponse reçue, RDV obtenu, ignoré (ne pas
  contacter), **Défaillant**. Niveau Contact/R1…/Relance terminée dérivé (D1, D2). `contacted`/`r1`/`r2`/`failure`
  disparaissent ; migration : leurs envois implicites sont enregistrés comme envois `migration` (contacted = 1, r1 = 2,
  r2 = 3), `failure` → séquence close « Relance terminée ». Remplace P1/P2/P7 du portage là où ils se contredisent.
- **D8 — Alertes qualité.** Table d'alertes (prospect ou entreprise ; type `email_error`, `function_to_check`,
  `data_inconsistent`, `company_to_check`, `import_conflict` ; source humain/import/IA ; ouverte/résolue). Une alerte
  ne change jamais l'état commercial. L'IA ne peut que proposer une alerte.
- **D9 — Erreur sur le mail.** Alerte `email_error` posée par un humain : le prospect garde Sxx, état et historique,
  sort des actions automatiques et apparaît dans la catégorie « Erreur sur le mail ». Reprise = nouvel e-mail + nouveau
  Sxx (D6).
- **D10 — Import.** Première feuille uniquement ; instantané brut de toutes les cellules non vides de chaque ligne,
  y compris les lignes exclues ; « Mode de contact » reste en métadonnée brute. `Statut_verification` ne touche plus
  jamais la vérification des e-mails et n'alimente l'activité que selon D11. Règle P7 supprimée.
- **D11 — Priorité humaine.** Pour prospect et entreprise : VIPER vide + Excel rempli → compléter ; même valeur →
  ignorer ; valeur différente → garder l'existant et créer une alerte `import_conflict` visible. Un champ vidé ou
  modifié par un humain n'est jamais rempli ni changé par un import. Un import ne change jamais un état, une séquence
  ou un Sxx posé par un humain (conflit → alerte).
- **D12 — « À vérifier ».** Fonction vide, e-mail absent, téléphone absent sans autre canal : affichés « À vérifier »,
  stockés vides.

## Slices

- [x] **S1 — Modèle backend** : cohortes, séquences, envois et niveau dérivé, états D7, alertes D8/D9, paramètre max
  relances, migration Alembic `0010` (données existantes, historique jamais réécrit), services + API REST + audit ;
  adaptation de tous les consommateurs backend (dashboard, segments Prospection, Accueil, export, historique) pour
  garder la gate verte. Le frontend n'est touché que si la gate l'exige.
- [ ] **S2 — Import Excel** : D3, D4, D10, D11 ; dates de cohortes inconnues dans la revue ; S0 ; `retraité` et autres
  valeurs non Sxx → alerte (+ Défaillant si fichier vérifié) ; tests sur fixtures synthétiques reproduisant la
  structure du classeur réel.
- [ ] **S3 — Relances et tableau de bord backend** : messages par séquence et rang illimité, « Marquer comme envoyé »,
  annulations, planning hebdomadaire (nouveaux contacts, R1, R2, R3… à envoyer cette semaine, répartition par niveau,
  catégories Erreur sur le mail / Relance terminée / Défaillant / S0).
- [ ] **S4 — Frontend fiche et Prospection** : fiche prospect (cohorte, niveau, historique des séquences, alertes,
  « À vérifier », changer de Sxx, Défaillant, Erreur sur le mail, Marquer envoyé), liste et filtres Prospection,
  Paramètres (cohortes, max relances). DA existante.
- [ ] **S5 — Frontend Contact et import** : tableau de bord hebdomadaire Contact, séquence mail à rangs variables,
  revue d'import (dates de cohortes, case fichier vérifié, conflits/alertes). DA existante.
- [ ] **S6 — Recette BASE CLIENT.xlsx et clôture** : import réel sur une base locale jetable (jamais `viper`, aucune
  donnée réelle hors machine), contrôle des critères §19, doc (`doc/features/*`, `doc/product/decision-log.md`),
  rapport final.

## Journal

- 2026-10-01 : handoff local créé par l'orchestrateur sur `lucie` (= `task/contact-port`, à jour de `main`). Analyse
  S0 consignée dans `README.md`. Décisions D1-D4 Humaines, D5-D12 par défaut.
- 2026-10-01 : S1 accepté (`f2ec5cf`, `2a6f72b`, `02aa8b2`, correctifs QA `21da384`, `bbfb956`, `d9192b6`, `714272b`,
  `8fd2637`) — migration 0010 (cohortes, séquences, messages par rang, `quality_alerts`, max relances), API, décisions
  R-01…R-11 dans `doc/product/decision-log.md`. Arbitrages : Q1 fusion d'un même code sur deux années (cohorte à
  revoir) ; Q2 changer de Sxx reprend Défaillant/Réponse/RDV en séquence, refusé sous `ignored`/`do_not_contact` ;
  Q3 « Marquer envoyé » refusé après réponse/RDV ; Q4 max relances 0..20. Gate : pytest 1289 + 1 test de perf hors
  budget sous charge mémoire (2,15 s / 2 s, vert seul), vitest 734, eslint/tsc/build verts. **Frontend et e2e cassés
  jusqu'à S4/S5** (anciens états, planificateur de semaine). Non corrigés : pas de `version` sur `PUT …/cohort` ;
  rattachement des messages par la migration non audité.
