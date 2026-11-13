# LOG — viper_mission_ui_redesign

## Origin and lifecycle
- Origin: remote (Drive folder `19amqeI770UfayqfOB8ClzoiFf8E-pAZY`; references in `15xgJjCXOTdZJE_F4MNV_tIjXwHl3XCDi`).
- Repo has no `docs/workflows/AGENT_TASK_LIFECYCLE.md`: fallback applied (Drive IDs + base branch `main` from project memory). No `current`/`done` Drive folder; connector cannot move folders, so the archive stays in place until Human moves it.
- Host `CLARICE`: no PR; task branch `task/viper_mission_ui_redesign` from refreshed `main` (4ce0180), merged to `main` only after explicit Human acceptance.
- Unpacked: SLICE.md of 00-05, TODO, Issues README, docs 01-05, `references/*.png`. Not copied: per-slice `metadata.json` / `human-validation.json` (trivial status stubs; still on Drive).
- Drive connector: one call at a time (parallel calls fail with SSL errors).

## Slice 00 — PM readiness (agent 0, done in person)
Decision: **READY**.

### References (3 screens, `references/`)
- `291ca0e3…png` Missions list: header + 4 KPI tiles (Toutes, Actives, En attente de relecture, Terminées 30 j), filters Statut / Type / Tri, colour-coded cards (icon, title, type + status chips, active switch, `…` menu, progress %, tâches / à valider / agents, dernière exécution).
- `2b5baa61…png` Mission detail, stats-style view: header (status/type/recurrence/place chips, pause/edit/delete/more), tabs, period + filters, progress donut, KPI tiles, "Appels API" area chart, per-agent donut, "Analyse temporelle", per-agent task timeline.
- `3537f694…png` Results tab + review dialog: confidence ring (93), counters, chips, proposal table (champ/avant/proposé/confiance/source/publiée/vérifiée), discarded value banner, agent JSON disclosure, Rejeter / Accepter la sélection (n).

### What already exists (shipped by `viper_mission_supervision_agent_telemetry`, merged in main)
Tabbed MissionDetailPage (Vue d'ensemble / Activité / Résultats / Statistiques) + live strip, Activity tab, Results tab review queue, redesigned ReviewDialog (confidence, evidence, reject-on-demand), Statistics tab (UTC buckets, text alternatives, per-agent breakdown). Mission card read model already has `tasks_total`, `tasks_done`, `results_pending`, `last_run_*`, `next_run_at`.

### Overlap
No unmerged branch touches `frontend/src/missions` or `frontend/src/agents` (checked task/pi-s5..s7, prospect-contact-ux, lucie, integration/lucie, feat/*). Telemetry task is merged. No serialisation needed beyond hot files below.

### Reconciliation notes (target vs shipped)
1. Target detail screen shows tabs `Tâches / Agents / Exécutions / Journaux`; shipped tabs are `Activité / Résultats / Statistiques`. Shipped navigation is behavioural truth: keep the tab set; Slice 01 decides where target regions land (shell/Overview/Statistiques). No new tabs invented.
2. "Appels API (base de données)", "Appels / minute", "Répartition des appels par agent" and the per-agent task timeline: the telemetry contract has no API/tool-call counter (event types: search, source_opened, observation, verification, progress, warning, error, decision_summary). Per decision log #6/#10 and Slice 03: do not infer; use factual proxies (activity events, tasks, results, sessions) or omit/label unavailable. Needs Human awareness (see risks).
3. List-card progress % = `tasks_done / tasks_total` is truthful; "agents" count and "Terminées (30 jours)" KPI need Slice 02 to confirm sources, else omit/minimal read-model request.
4. Target mock data (Normandie, Agent A/B/C, round numbers) is illustrative; never reproduce as values.

### Hot files
`frontend/src/missions/MissionDetailPage.tsx`, `MissionsPage.tsx`, `missions.css` (699 l.), `stats.css`, `results.css`, `activity.css`, `vocabulary.ts`, `frontend/src/agents/ReviewDialog.tsx` + `review.css`/`agents.css`, `frontend/src/api/missions.ts`. Rule: 01 owns shared primitives/tokens; 02/03/04 use new surface-specific files; shared-file patches serialised by PM.

### Graph
Unchanged: 01 -> (02 ‖ 03 ‖ 04) -> 05. Task Types: not applicable (UI redesign, no agent task types used).

### Risks for Human check
- Target "Appels API" widgets cannot be backed by real data today.
- Tab naming differs from target.

## Slice 01 - UI contract (implementer)
Contract: `01-ui-contract/CONTRACT.md`. Shared primitives under `frontend/src/missions/` (`missionUi.css`, KPI tile, panel, status chip, donut, accent). New tokens violet/indigo/teal-soft in `tokens.css`. Open decisions D1-D6 in CONTRACT section 6 (30-day completed KPI, agents count, API-call widgets unavailable, overview vs statistics split).
Known pre-existing failures in `theme/tokens.test.ts` (not from this slice): `prospection/overview.css`, `warehouses/warehouses.css` contain raw colour literals.
