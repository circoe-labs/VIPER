# Home — global dashboard (Task 16)

Home (`/`, *Accueil*) answers two questions, in this order: **where do the base and the contact activity stand?**
and **what to do next?** (locked decision 19; grill section A: global visibility first, actions beneath). Everything
comes from the V1 database — imports and manual entries. Email sending, Calendly and the future IProspect / IContact
agents are not part of V1: Home shows no widget, figure or placeholder for them, only one discreet sentence saying so.

Decisions: I-110 … I-117 in the decision log. Prospect counts reuse the canonical segments of
[prospection-kpis.md](prospection-kpis.md) ([ADR-0014](../adr/0014-canonical-prospect-segments.md)) — Home never
re-defines a KPI.

## KPI definitions

| Home card | Definition | Opens |
|---|---|---|
| *Prospects* | segment `all` | `/prospection` |
| *Entreprises* | every company row, with or without prospects | `/prospection/companies` |
| *Actifs*, *Inconnus*, *Inactifs*, *Opposition* | segments `active`, `unknown`, `inactive`, `do_not_contact` | `/prospection?segment=…` |
| *Jamais vérifiés*, *À revérifier*, *E-mail manquant / invalide / non vérifié* | segments `never_verified`, `needs_recheck`, `email_missing`, `email_invalid`, `email_unverified` (with the stale-threshold note of Prospection) | `/prospection?segment=…` |
| *À contacter*, *Échus*, *Contactés*, *Sans réponse*, *Réponses*, *Rendez-vous* | segments `to_contact`, `due`, `contacted`, `no_response`, `responses`, `appointments` | `/prospection?segment=…` |
| *Devis envoyé*, *Suivi du devis*, *Gagné*, *Pas intéressé* (*Suivi commercial léger*) | prospects whose **current** tracking stage is `quote_sent`, `quote_follow_up`, `won`, `not_interested` — manually recorded stages only, nothing inferred from dates | `/prospection?tracking_status=…` |

Each segment card equals the Prospection counter it opens (same function, `count_segments`, same business day); each
stage card equals Prospection's *Tous* counter under the *Suivi de contact* filter of that stage (tested on random
bases). A glyph turns to the warning colour on *Jamais vérifiés*, *À revérifier*, the three e-mail cards and *Échus*
when their count is not zero (glyph + text, never colour alone).

## Monthly progress

Two figures for the current month (Europe/Paris, `app/core/business_time.py`), each against an **informative** target
(`VIPER_MONTHLY_CONTACT_TARGET` = 100, `VIPER_MONTHLY_APPOINTMENT_TARGET` = 10 — the source requirement "100 contacts /
10 rendez-vous"), plus the five months before as small columns:

- **Prospects contacted for the first time** in month M: prospects whose tracking **first** entered a contacted stage
  (`contacted` or any later stage — `CONTACTED_STAGES` of the segments) in M, according to
  `contact_tracking_status_history`, **unless that first entry was written by an import**. An imported stage restates a
  legacy contact made at an unknown earlier date: neither the import's history row nor a later follow-up makes the
  person newly contacted. A person imported at *À contacter* and contacted by hand this month counts. Later moves
  (relance, réponse) never count again. Opposed or inactive people still count (a historical fact, like the
  `contacted` segment).
- **Appointments obtained** in month M: prospects whose tracking first entered an appointment stage
  (`appointment_obtained`, `quote_sent`, `quote_follow_up`, `won` — `APPOINTMENT_STAGES`) in M, same import rule. Chosen
  over "`appointment_at` in M" because the target measures the prospecting work (securing meetings) when it is done;
  `appointment_at` is the meeting's date — often in a later month, overwritten when rescheduled, and it would count
  meetings held rather than obtained. A direct jump to *Devis envoyé* counts (an appointment was obtained on the way);
  *Rendez-vous obtenu* → *Devis envoyé* does not count twice.
- Month boundaries are midnight in Paris (DST-aware): 31 Aug 22:30 UTC is September.
- Every stage change is in the history, whatever the screen: the Prospect editor and Database Explorer edits of
  `contact_tracking` both go through `contact_tracking.save_contact_tracking` (I-64), which writes the row with the
  signed-in user as actor — an explorer change into `contacted` or `appointment_obtained` counts this month (tested).
- Limit: an appointment (or a response) recorded **only as a date**, with the stage left behind, is not in the monthly
  figure — no stage entered an appointment stage — but it is in the `appointments` (`responses`) segment. V1 keeps one
  tracking cycle per prospect: "first" means first in that cycle.

The meter's full track is the target (the fill stops there; the text says `12 sur un objectif indicatif de 10 (120 %)`).
The figure sits in a panel of the same weight as the recent activity, below the KPIs and next actions — never the
page's headline (interface spec: "do not make 10 meetings the sole dominant UI metric").

## Next actions

Three short lists (5 people each, with the group total), in this order — time-bound commitments, then overdue work,
then conversions waiting; within a group the oldest (or soonest) first, ties by id. No other ranking is invented.

| Group | People | Order |
|---|---|---|
| *Rendez-vous des 7 prochains jours* | *actionable* (segments: contactable and not inactive) with `appointment_at` from the start of today to the end of the 6th day after | soonest first |
| *Contacts échus* | segment `due` | oldest planned contact first |
| *Réponses sans rendez-vous* | actionable, answered (`responses` predicate), no appointment (`appointments` predicate false), stage ≠ `not_interested` | oldest response first, no date last |

A person opens in Prospection within the list they belong to (`/prospection?segment=due&sort=planned_contact&prospect=<id>`,
Task 14 contract), so the Prospect editor's *Enregistrer et suivant* walks that queue; *Tous les échus* / *Toutes les
réponses* / *Tous les rendez-vous* open the segment (the last two are wider than the group, as their labels say).

## Recent activity

- **Derniers imports** — the 5 latest import batches (`import_batches.list_batches`): file name, status badge, `12 lignes
  importées sur 14 · 2 exclues`, who, when; a committed one opens `/prospection?import_batch=<id>`.
- **Dernières modifications** — the latest **human** saves on prospects and companies (and their e-mails, phones,
  tracking, sources, establishments), from `audit.recent_activity(subject_types=("prospect", "company"),
  actor_types=(HUMAN,))`. Import writes (listed above), sign-ins, exports, SQL queries and Settings changes stay out.
  Consecutive events of one request on one record form one line (8 lines, from the latest 40 events). The API sends
  **no field value and no raw `changes`/`context`**: only action names, entity types, the tracking stage before/after,
  the source (`via Base de données` for explorer edits) and the record's current name (none once deleted).
  French wording lives in one place, `frontend/src/home/activity.ts` (« Fiche modifiée », « E-mail ajouté »,
  « Suivi : Contacté → Réponse reçue », « Changement d’entreprise », « Opposition enregistrée »…; an unknown action reads
  « Modification »). Task 19 replaces it with the full history formatter over the same data.

## States

Loading (*Chargement de l’accueil…*), error with *Réessayer*, and an **empty base** (no prospect): an invitation to
*Importer Excel* (plus *Ajouter un prospect* once the Prospect editor can create), the recent imports/edits panels (a
failed import still shows) and no figure at all. Empty groups say so (*Aucun contact prévu au plus tard aujourd’hui.*).

## API — `GET /api/home` (session required, read-only)

`{today, stale_threshold_days, counts: {<segment>: n}, companies, stages: {quote_sent, quote_follow_up, won,
not_interested}, progress: {contact_target, appointment_target, months: [{month, contacted, appointments}] (6, oldest
first)}, next_actions: {appointments|due|responses: {total, items: [{prospect_id, first_name, last_name, company_name,
tracking_status, at, referent_name}]}}, recent_imports: [import batch as in /api/imports], recent_edits: [{occurred_at,
actor_display, source, subject_type, subject_id, subject_label, actions: [{action, entity_type, status_before,
status_after}]}]}`.

Cost: **9 statements** whatever the base size (segments aggregate, companies + stages, monthly progress — one pass
over the status history grouped by tracking —, 3 action groups with `count(*) OVER ()`, imports, audit events, current
names of the edited prospects/companies). No index added: ≈ 0.25 s on 20 000 prospects with history
(`tests/test_prospection_performance.py`); the history index `(contact_tracking_id, changed_at)`, the audit
`occurred_at` index and the import batch ordering serve the other reads.

## Page layout

Header (*Accueil*, lead sentence with the business day, *Importer Excel*, *Ouvrir la prospection*) → *État de la
base* (*Base*, *Vérification* card rows) → *Activité de contact* (*Suivi de contact*, *Suivi commercial léger*) →
*Prochaines actions* (three columns, stacked when narrow) → three equal panels: *Progression du mois*, *Derniers
imports*, *Dernières modifications* → the V1 scope sentence. At 1280×800 and 1440×900 the first screen is the state of
the base and the contact activity. Styles: `frontend/src/home/home.css` (see the design system).

## Code and tests

| Layer | Where |
|---|---|
| Service | `backend/app/services/home.py` (`home_summary`, `monthly_progress`, `next_actions`, `recent_edits`) |
| Router | `backend/app/api/routes/home.py`; settings `VIPER_MONTHLY_CONTACT_TARGET` / `VIPER_MONTHLY_APPOINTMENT_TARGET` |
| Frontend | `frontend/src/home/` (`HomePage`, `NextActions`, `MonthlyProgress`, `RecentActivity`, `activity.ts`, `home.css`), `frontend/src/api/home.ts` |

- Backend `tests/test_home.py`: counts == Prospection counters on the Prospection edge cases and on random bases
  (stage counts == the tracking-status filter), companies and stages from recorded statuses only, empty base; months
  list; first contact once in its month, earlier contact followed up later, direct later stage, opposed still
  counted; import exclusion (imported contact + later follow-up, imported *à contacter* then contacted, imported
  appointment); Paris month boundaries incl. DST; appointment first entry (direct quote, no double count, won later,
  date without stage); history from the real tracking service; next actions on the edge cases (DNC and inactive
  excluded) and ordering / limit / window bounds; recent edits grouping, import writes excluded, no e-mail or reason
  in the output, deleted subject; latest imports; 9 statements for 3 and 60 prospects.
  `tests/test_home_api.py`: 401, GET only, contract and counts == `/api/prospection/counters`, targets from settings,
  no raw payload, staged Database Explorer stage changes (into `contacted`, into `appointment_obtained` after an
  imported contact) counted in the current month as human history rows. `tests/test_prospection_performance.py`: Home on 20 000 prospects.
- Frontend `src/home/HomePage.test.tsx` (heading order, every card's segment/filter URL and count, click → URL, meters'
  text alternatives and 6-month table, next-action links, readable import/edit lines without technical names, empty
  base with/without the editor's create, V1 scope sentence and no agent/e-mail widget, error + retry),
  `src/home/activity.test.ts` (formatter). Shell tests stub `/api/home` (`src/test/homeApi.ts`).
- Playwright `e2e/home.spec.ts`: imports its own people, compares every displayed figure and next-action link with the
  captured `/api/home` answer, clicks *Échus* and *Sans réponse* and finds its own people by search in the segment,
  opens a committed import from the recent activity; screenshots dark/light at 1440×900 and 1280×800 without horizontal
  overflow.
