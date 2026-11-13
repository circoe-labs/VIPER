# Mission UI contract (Slice 01)

Status: frozen at Slice 01 commit. Consumers: Slices 02, 03, 04, then 05.
Visual truth = the three references in `../references/`. Behavioural truth = current VIPER code (`frontend/src/missions/*`, `frontend/src/agents/*`, `frontend/src/api/missions.ts`) and `doc/architecture/mission-telemetry.md`. Where they disagree, the screen is adapted, never the domain.

Reference files: **R1** `291ca0e3…` Missions list. **R2** `2b5baa61…` mission detail, statistics-style view. **R3** `3537f694…` Results tab + review dialog.

Key facts found while mapping (they shape everything below):

1. **R3 is nearly the shipped app.** It is a screenshot of the live Results tab + `ReviewDialog` (tabs, status chips, `ReviewSummary` ring, evidence, Rejeter / Accepter la sélection). Slice 04 re-skins and recomposes; it does not rebuild. The one structural gap is the proposal **table** (Champ / Avant / Proposé / Confiance / Source / Publiée / Vérifiée): shipped `ItemRow` is a card-like row with Avant / Proposé tags. All seven columns have backing fields on `ProposalItem` (`label`, `before`, `after`, `confidence`, `source`, `source_published_at`, `source_checked_at`).
2. **Two progress semantics exist.** List card: `tasks_done / tasks_total` where `tasks_done` = tasks **accepted** (`backend/app/services/missions.py::_counts`). Overview: `tasks.finished / tasks.total` where finished = accepted + failed + cancelled (`mission_supervision.FINISHED_TASK_STATUSES`). Never show both under the same word. List: « X % validées ». Detail/Stats: « X % des tâches traitées ».
3. **`results_pending` on the card = tasks in status `submitted`**, while `useMissionProposals()` lists pending **results**. Same order of magnitude, not guaranteed identical. The list KPI « En attente de relecture » uses `useMissionProposals().data.length` (it equals the « Relire » list under it); the per-card « à valider » uses `card.results_pending`.
4. **No tool/API-call counter exists** (`ACTIVITY_EVENT_TYPES` = search, source_opened, observation, verification, progress, warning, error, decision_summary). R2 « Appels API », « Répartition des appels par agent », « Appels / minute », and the typed task timeline (Traitement / Appel API / Envoi de résultat) are **unavailable**.
5. **`MissionCard` has no agent count, no completion date, no result kind.**

---

## 1. Region mapping

Legend: **retained** (same behaviour, restyled) · **moved** (same thing, new place) · **consolidated** (several current things become one) · **transformed** (same data, new presentation or derived client-side from existing fields) · **unavailable** (no backing data: omit or show an explicit « Indisponible », never invent).

### 1.1 R1: Missions list (owner: Slice 02)

| # | Region (R1) | Current component / hook | API field(s) | Action | Verdict |
|---|---|---|---|---|---|
| 1 | Sidebar, global search, theme, user | `shell/*` | n/a | n/a | retained, out of scope |
| 2 | Title « Missions » + subtitle + (i) | `PageHeader` + `InfoTip` in `MissionsPage` | n/a | n/a | retained; subtitle wording free, keep the InfoTip help text |
| 3 | « + Nouvelle mission » | `Button` primary → `CreateMissionDialog` | n/a | open create dialog | retained |
| 4a | KPI « Toutes les missions » | none (new tile) | `useMissions()` unfiltered → `total` | none | transformed; **must read the unfiltered query** (`missionKeys.list(undefined)`), not the filtered one |
| 4b | KPI « Actives » | none | unfiltered `items.filter(status==='active').length` | none | transformed |
| 4c | KPI « En attente de relecture » | « Propositions à relire (n) » `Card` | `useMissionProposals().data.length` | none (the « Relire » list stays below) | consolidated: tile + the existing list |
| 4d | KPI « Terminées (30 jours) » | none | **no completion timestamp** on `MissionCard` | none | **unavailable as « 30 jours »**. Ship « Terminées » = `items.filter(status==='done').length` (all time) with that exact label. Human/PM decision D1 |
| 5a | Filter « Statut » | `FILTERS` buttons, `useMissions(status)` | `status` (server filter) | `setFilter` | transformed (chips → select or chips, free) |
| 5b | Filter « Type » | none | `card.type`, labels `MISSION_TYPE_LABELS` | client-side filter | transformed: UI-only, derived. Use VIPER type words (Prospection ciblée, Recherche de signaux, Enrichissement, Vérification, Autre); R1 « Veille » is not VIPER vocabulary |
| 5c | Sort « Dernière exécution » | none | `last_run_at`, `created_at`, `name` | client-side sort | transformed: UI-only. Options: Dernière exécution (default), Création, Nom. `null` last_run sorts last |
| 6 | Card shell, per-mission colour | `Link.mission-card` | `card.id` | navigate `/missions/:id`, right-click menu | transformed: `MissionAccent` from `accentForMission(card.id)`; `className="mui-accent"` + `data-hue` on the Link itself |
| 6a | Card icon tile | none | `card.type` | none | transformed: `MISSION_TYPE_ICONS[card.type]` in `.mui-icon-tile` |
| 6b | Title | `h2.mission-card__title` | `name` | none | retained |
| 6c | Active switch | `ActiveSwitch` + `useSetMissionStatus` | `status` | PATCH status active/paused; shown only when active or paused | retained |
| 6d | « … » menu | `Menu` via `onMenu` | n/a | Ouvrir / Modifier… / Supprimer… (+ right-click) | retained, behaviour untouched |
| 6e | Type chip | `mission-card__meta` text | `type` | none | transformed: `Badge` + `MISSION_TYPE_LABELS` |
| 6f | Status chip « Active » | `StatusBadge` | `status` | none | consolidated: `MissionStatusChip` |
| 6g | « En attente de relecture » chip (card 6 of R1) | `mission-card__todo` text | `results_pending > 0` | none | transformed: `StatusBadge tone="warning"` « n à relire », shown **in addition** to the status chip (R1 swaps them; VIPER keeps both facts) |
| 6h | Progress bar + « 87 % » | none | `tasks_done / tasks_total` | none | transformed: label « validées ». `tasks_total === 0` → no bar, text « Aucune tâche » (never 0 %) |
| 6i | « 8 tâches » | none | `tasks_total` | none | transformed |
| 6j | « 6 à valider » | `mission-card__todo` | `results_pending` | none | retained |
| 6k | « 3 agents » | none | **no field** (`agent_label` is the one configured agent or null) | none | **unavailable as a count**: show `agent_label ?? 'Automatique'` in that slot. Decision D2 if a count is wanted (needs read-model: distinct agents with a session) |
| 6l | « Dernière exécution : date » | `mission-card__run` | `last_run_at`, `last_run_status` | none | retained (`momentLabel`; « Jamais exécutée »; failure state with `AlertIcon` + « (échec) » kept) |
| 6m | prompt clamp, linked data count, recurrence, « Prochaine » | `mission-card__prompt/__facts/__run` | `prompt`, `targets_count`, recurrence fields, `next_run_at` | none | **removed from prominence**: one quiet secondary line (recurrence · prochaine exécution), prompt as `title` tooltip or one clamped line. Nothing deleted from the data |
| 7 | Loading / empty / error | `missions-muted`, `EmptyState`, `missions-error` | `useMissions` state | retry | retained, restyled per §4 |
| 8 | Edit from list | `EditMission` | `useMission(id)` | open dialog | retained |
| 9 | « Propositions à relire » list + `ReviewDialog` | `Card` + `ReviewDialog` | `useMissionProposals` | `setReviewId` | retained (R1 has no such list; it must not disappear, it is the review entry from this page) |

### 1.2 R2: mission detail, statistics-style (owners: Slice 04 shell/overview, Slice 03 Statistiques)

R2 mixes the page shell, the overview and the statistics into one screen. **The tab set stays `Vue d'ensemble / Activité / Résultats / Statistiques`** (shipped, tested, `?tab=`). R2 tabs map: Vue d'ensemble → Vue d'ensemble · Tâches → section « Tâches » of Vue d'ensemble · Agents → live agents (Vue d'ensemble) + per-agent table (Statistiques) · Exécutions → section « Exécutions » of Vue d'ensemble · Journaux → Activité tab.

| # | Region (R2) | Current component / hook | API field(s) | Action | Verdict | Slice |
|---|---|---|---|---|---|---|
| 1 | « ← Missions » | `Link.missions-back` | n/a | navigate | retained | 04 |
| 2 | Icon tile + title | `PageHeader title` | `card.name`, `card.type` | none | transformed: `.mui-icon-tile` with `MISSION_TYPE_ICONS`, accent from `accentForMission(card.id)` (same colour as its list card) | 04 |
| 3a | Chip « Active » | `StatusBadge` | `card.status` | none | consolidated: `MissionStatusChip` | 04 |
| 3b | Chip « Prospection » | text in meta | `card.type` | none | transformed: `Badge` + `MISSION_TYPE_LABELS` | 04 |
| 3c | Chip « Ponctuelle » | text in meta | recurrence fields | none | transformed: `Badge` + `recurrenceLabel(card)` | 04 |
| 3d | Chip place « Normandie » | none | `MissionDetail.rule.geography` (nullable) | none | transformed: shown **only when non-null**, `MapPinIcon` | 04 |
| 3e | Agent label | text in meta | `card.agent_label` | none | retained as chip « Automatique » / label | 04 |
| 4a | Pause button | « Désactiver / Activer » `Button` | `card.status` | `useSetMissionStatus` | retained, accessible name and tooltip unchanged (icon-first allowed, text must stay available as `label`/`title`); hidden when closed | 04 |
| 4b | Edit button | « Modifier » | n/a | `CreateMissionDialog` | retained; disabled when closed | 04 |
| 4c | Delete button | « Supprimer » | n/a | `DeleteMissionDialog` | retained; `danger` variant | 04 |
| 4d | « ⋮ » more | none | n/a | n/a | **unavailable** (no extra action exists): omit | 04 |
| 5 | Tabs | `Tabs` + `MISSION_TABS` | `?tab=` | `selectTab` | retained, set unchanged; « Résultats » keeps its pending count | 04 |
| 6 | Banners (paused, cannot run, last run failed) | `missions-banner*` | status, `missingForRun`, `lastRun.note` | none | retained | 04 |
| 7 | Live strip | `MissionLiveStrip` | `useMissionOverview` (polled 15 s) | « n résultats à relire » → Résultats | retained; may be recomposed with 8/9 but keeps every state (loading / error+retry / empty / live / stale) | 04 |
| 8 | « Progression » card: ring 87 %, « 87 % des tâches traitées », bar, « 87 / 100 » | live strip `<progress>` | `overview.tasks.finished / total` | none | transformed: ring = existing `ui/ScoreRing` (tone `success`, caption carries « %), bar = `<progress>`. Label « traitées ». `total === 0` → « Aucune tâche » | 03 (Statistiques top) and 04 keeps the strip |
| 9a | KPI « Agents actifs » | live strip stat | `overview.active_agents` | none | transformed: `MissionKpiTile` hue blue | 03 |
| 9b | KPI « Tâches terminées » | none | `overview.tasks.finished` (accepted+failed+cancelled) **or** `statistics.tasks_by_status.accepted` | none | transformed: label **« Tâches traitées »** if it uses `finished` (R2 « terminées » would hide failed/cancelled). Pick one source, document it in the component | 03 |
| 9c | KPI « Tâches restantes » | none | `overview.tasks.total - finished` | none | transformed (derived, exact) | 03 |
| 9d | KPI « Tâches totales » | none | `overview.tasks.total` | none | transformed | 03 |
| 10 | Period « 30 derniers jours » | `Segmented` 7/30/90 + bucket | `useMissionStatistics({days,bucket})` | `setDays` | retained, **inside the Statistiques tab only** (it does not apply elsewhere) | 03 |
| 11 | « Filtres (2) » | none | n/a | n/a | **unavailable** (no cross-cutting filter model); Results tab keeps its own filters | n/a |
| 12 | « Appels API (base de données) » area chart, 4 892 appels, moy./agent | none | **no call counter** | none | **unavailable**. Replace by the factual equivalent: « Activité des agents » = `logs_series` (journal entries per bucket) in `StatsChart`, KPI = sum + average per agent from `agents[].logs`. Title must say « entrées de journal », never « appels » | 03 |
| 13 | « Répartition des appels par agent » donut | none | **no call counter** | none | transformed: donut « Répartition de l'activité par agent » from `statistics.agents[].logs` (or `.results`), unit « entrées » / « résultats ». Valid categorical donut (§2.5) | 03 |
| 14a | « Analyse temporelle » Durée de la mission (28 jours) | none | `statistics.since/until` is the *view window*, not the mission span; `runs[].started_at/finished_at`, `card.created_at` | none | transformed only if derived exactly (first run start → last run end); else omit | 03 |
| 14b | « Temps de traitement (moy.) » | none | `avg_review_seconds` is **review latency** (submission → decision), not processing time | none | transformed: relabel **« Délai moyen de relecture »** (already shipped KPI). Never call it processing time | 03 |
| 14c | « Appels / minute (moy.) » | none | **no call counter** | none | **unavailable**: omit | 03 |
| 15 | « Chronologie des tâches par agent » Gantt (Traitement / Appel API / Envoi de résultat) | none | tasks have `submitted_at`, no start/phase timestamps; sessions have `started_at/ended_at` per agent | none | **unavailable as drawn** (no typed phases). Allowed substitute: per-agent session spans from `useMissionSessions` (`started_at`→`ended_at ?? last_seen_at`), labelled « Sessions », with the table alternative. If that is too heavy for the slice, omit and record in Issues | 03 |
| 16 | Per-agent « Tâches » count (34/31/22) | `AgentTable` | `statistics.agents[]` (sessions, logs, results, accepted, rejected, pending_review) | none | retained as the table alternative (R2 shows tasks; VIPER has results) | 03 |
| 17 | Results-by-status distribution (not in R2, required by decision log #6) | `StatsChart` + KPIs | `results_by_status` | none | new donut « Résultats par statut » (≤4 mutually exclusive categories) with legend + table | 03 |
| 18 | Overview content (not in R2: Consigne, Données liées, Exécutions, Tâches) | `MissionOverviewTab` | `MissionDetail` | `Relire` per task | retained, restyled with `MissionPanel` | 04 |
| 19 | Warnings (`overview.warnings`) | `MissionLiveStrip` | `warnings[]` | none | retained | 04 |

### 1.3 R3: Results tab + review dialog (owner: Slice 04)

| # | Region (R3) | Current component / hook | API field(s) | Action | Verdict |
|---|---|---|---|---|---|
| 1 | Tab strip « Vue d'ensemble / Activité / Résultats 7 / Statistiques » | `Tabs` | pending count | select | retained (already identical) |
| 2 | Status chips « Tous 8 · À relire 7 · Validé 1 · Rejeté 0 » | `results-status__chip` | `status_counts` | `setStatus` | retained; « Remplacé » chip stays (4th status) |
| 3 | Filters « Agent », « Exécution » | `ResultsTab` selects | `agent_id`, `run_id` | filter | retained |
| 4 | Result cards (dimmed behind dialog) | `ResultsCard` | `MissionResultCard` | open dialog | retained, restyled |
| 5 | Dialog title « Compléter un employé » + subtitle (société, agent, « il y a 5 min ») | `Modal` title in `ReviewDialog` | `task_type`, `company_name`/`prospect_name`, `submitted_by_label`, `submitted_at` | close | retained |
| 6 | Confidence ring 93 + « Confiance globale / Élevée » | `ReviewSummary` + `ScoreRing lg` | `proposal.confidence` (0-100, nullable) | none | retained; null → « Non renseignée » (already) |
| 7 | Counters « 1 proposition · 1 source · 1 écartée » | `ReviewSummary` counts | `proposal.items.length`, distinct `source`, `proposal.refused.length` | none | retained |
| 8 | Chips « Nomination détectée », « SPB Group », « Aucun e-mail public » | none | `proposal.kind`/`task_type`, `company_name`, no e-mail fact | none | transformed: render only chips backed by `task_type` / `company_name` / `prospect_name`. « Aucun e-mail public » has **no field**: omit |
| 9 | Proposal table (Champ, Avant, Proposé, Confiance, Source, Publiée, Vérifiée, row checkbox) | `ItemRow` + `ReviewEvidence` | `ProposalItem` (see key fact 1); `source_published_at` null → « inconnue », `source_checked_at` null → « non datée » (wording as in R3) | per-row checkbox → `chosen` set | transformed: table layout (`Table` density compact, real `<th>`); on narrow widths rows stack (§3). Selection semantics untouched |
| 10 | Discarded banner « Valeur écartée · Rôle : Unknown role » | `review-refused` | `proposal.refused[]` (`label`, `message`) | none | retained, danger-soft banner, glyph + text |
| 11 | « JSON soumis par l'agent » disclosure | `details.review-json` | `raw` | none | retained |
| 12 | « Rejeter » (red) / « Accepter la sélection (1) » (green) | `ReviewDecision` | `useRejectResult`, `useAcceptResult` | reject (reason on demand), accept selected keys | retained: no behaviour change; acceptance never asks a reason; rejection asks one only when chosen |
| 13 | Decided read-only state | `DECIDED_LABELS` | `status`, `accepted_items`, `decided_by_display` | none | retained |
| 14 | Loading / error / stale / rebuild | `agents-muted`, `agents-error`, `useRebuildResult` | n/a | retry/rebuild | retained |

---

## 2. Shared tokens and primitives

Everything below already exists in `theme/tokens.css` / `ui/*`, except the items marked **new (Slice 01)**.

### 2.1 Spacing, shape, type (no new values)

- Spacing: `--space-*` (4 px base). Panel padding `--space-4` / `--space-5` (≤ 640 px: `--space-4`). Grid gap between tiles/cards `--space-3` (tiles) and `--space-4` (panels). Page rhythm between sections `--space-5` (the `.missions` grid).
- Shape: card/tile/panel `--radius-lg`, icon tile and inputs `--radius-md`, chips `--radius-full`. Border `--border-width`.
- Type (Inter): page title `--text-2xl` semibold (PageHeader, untouched) · panel/card title `--text-lg` semibold, `--tracking-tight` · KPI figure `--text-2xl` bold, tabular numerals · label `--text-sm` medium muted · hint/meta/chip `--text-xs`. Numbers always `font-variant-numeric: tabular-nums`; numbers formatted with `Intl.NumberFormat('fr-FR')` (`43,9 %`, `4 892`).
- Elevation: `--shadow-card`. Glow (`--shadow-glow`) only on the pressed/selected state, never decorative.
- Motion: `--duration-*` tokens only (already 0 under reduced motion). The skeleton shimmer is disabled under `prefers-reduced-motion`.
- R1/R2 use neon glow borders and a dark purple/green wash. VIPER's rule is « neon is a signal, not wallpaper » (`doc/design/design-system.md`): the accent edge is a 42 % mix into the normal border and a soft tint gradient; no outer glow on resting cards.

### 2.2 Card

`.mui-accent` (class, usable on a link/button/section) = tinted surface + hue edge, driven by `data-hue`. `MissionPanel` = `section.mui-panel.mui-accent` with icon tile + heading + optional actions (named region, `level` 2 or 3). Plain `ui/Card` stays for neutral, non-accent blocks.

### 2.3 Hues (**new**: tokens in `tokens.css`, mapping in `missionUi.css`)

Six decorative **accents** (R1: green, blue, amber, purple, teal, indigo) plus three semantic hues for chart segments and KPI tiles.

| `data-hue` | Foreground (dark / light) | Tint | Origin |
|---|---|---|---|
| `green` | `--color-accent-fg` | `--color-accent-soft` | existing |
| `blue` | `--color-info-fg` | `--color-info-soft` | existing |
| `amber` | `--color-warning-fg` | `--color-warning-soft` | existing |
| `purple` | `--color-violet-fg` | `--color-violet-soft` | **new** (`--nc-violet*`, reuses the prospects purple pair) |
| `teal` | `--color-accent-2-fg` | `--color-teal-soft` | fg existing, tint **new** |
| `indigo` | `--color-indigo-fg` | `--color-indigo-soft` | **new** (`--nc-indigo*`) |
| `success` / `danger` / `neutral` | `--color-success-fg` / `--color-danger-fg` / `--color-neutral-fg` | their `-soft` | existing |

All pairs (fg on `surface`, fg on its own tint, both themes) are asserted ≥ 4.5:1 by `theme/tokens.test.ts` (added). A component sets only `data-hue`; it reads `--mui-fg` / `--mui-soft`. **No raw colour literal outside `tokens.css`** (enforced by the same test).

Rules:
- An accent is **decoration**. It never encodes status, type, priority or health. Status = `StatusBadge` (glyph + word + tone). A paused mission keeps its accent.
- A mission's accent is `accentForMission(card.id)` (stable hash of the id; same colour on its list card, detail header and stats panels). No stored field, no new domain concept.
- Status tones keep their meaning: success mint (not brand green), warning amber, danger red, info blue, neutral grey (see `doc/design/design-system.md`).
- Never colour alone: every hue-coded element also carries text and/or a glyph.

### 2.4 Primitives (**new**, `frontend/src/missions/`, styles in `missionUi.css`)

| File | Export | Used by | Notes |
|---|---|---|---|
| `missionAccent.ts` | `MISSION_ACCENTS`, `MissionAccent`, `MissionHue`, `accentForMission(id)`, `MISSION_TYPE_ICONS` | 02, 03, 04 | pure |
| `MissionStatusChip.tsx` | `MissionStatusChip` | 02 (card), 04 (header) | wraps `StatusBadge` + `labels.ts`; replaces the two duplicated renderings |
| `MissionKpiTile.tsx` | `MissionKpiGrid`, `MissionKpiTile` | 02 (4 counters), 03 (KPI strip), 04 (optional) | `<dl>` semantics; `value`: number/string = shown, `undefined` = loading « – », `null` = unavailable « — » + « Non disponible. » |
| `MissionPanel.tsx` | `MissionPanel` | 03 (every chart panel), 04 (overview sections) | named region |
| `MissionDonut.tsx` + `donutModel.ts` | `MissionDonut`, `donutModel`, `donutSummary` | 03 (agents, results by status), 04 only if it needs one | see §2.5; model unit-tested in `donutModel.test.ts` |
| `missionUi.css` | `[data-hue]` mapping, `.mui-accent`, `.mui-icon-tile`, `.mui-panel*`, `.mui-kpi*`, `.mui-donut*`, `.mui-state`, `.mui-skeleton`, `.mui-num` | all | prefix `mui-`; **do not grow `missions.css`** |

Reused as is: `ui/Badge` (`StatusBadge`, `Badge`), `ui/Button`, `ui/Card`, `ui/Table`, `ui/Tabs`, `ui/EmptyState`, `ui/Menu`, `ui/ScoreRing`, `ui/CounterCards` (interactive filter counters, Prospection style), `ui/icons`, `labels.ts`, `vocabulary.ts`, `statsModel.ts` (`formatCount`, `formatRate`, `formatDuration`, UTC bucket labels), `StatsChart` (stacked columns), `agents/reviewFormat.ts` (confidence bands).

Showcase: `/_dev/ui` (dev server only) has a « Missions : tuiles, panneaux, anneau » card exercising every primitive, loading and unavailable states, and the empty donut.

### 2.5 Chart language

General: hand-rolled SVG/CSS, no chart library (repo rule, see `StatsChart`). Every chart has (1) a visible title, (2) a legend that states label and figure, (3) a table alternative reachable by keyboard (« Voir les données en tableau », a `<details>` with `ui/Table`), (4) a `role="img"` text summary naming every category with figure and share. Time axes are **UTC** and say so (« Période (UTC) »). Zero buckets are drawn, not skipped. Unavailable data is a message, not an empty chart.

Choosing the form:
- Part-of-whole of a **small set of mutually exclusive categories** at one point in time → **donut** (§ below).
- Change over time → stacked columns (`StatsChart`) or one line/area; never a donut.
- Ranking/comparison of many items → table or horizontal bars.
- One bounded 0-100 value → `ScoreRing` (+ number in words). One ratio of counts → `<progress>` + « x / y ».

Donut rules (`MissionDonut` enforces the first four):
1. Total must be > 0, else the donut is replaced by an explicit empty message (`emptyText`, default « Aucune donnée sur la période. »). Never an empty ring, never « 0 % » slices.
2. At most **6** categories; beyond that the smallest are folded into « Autres » (`donutModel`). Prefer ≤ 4.
3. Non-finite or negative figures are treated as 0.
4. Centre shows the **total and its unit** (« appels » is forbidden unless telemetry records calls; use « entrées », « résultats », « tâches »). Legend row = swatch + label + figure + share (`43,9 %`, fr-FR). Share is displayed with at most one decimal.
5. Categories are **mutually exclusive and exhaustive** (task status, result status, agent share of journal entries). Do not mix units (e.g. sessions and results) in one ring.
6. Colour order for **categorical** (agents): green, blue, amber, purple, teal, indigo, then « Autres » neutral. Colour for **status** distributions follows status tones (accepted success, rejected danger, pending warning, superseded neutral). A segment is never identified by colour alone (legend + table).
7. Arcs are separated by a small gap; single-segment rings have none.
8. An agent's colour is its rank in the current list, not an identity; do not promise cross-chart colour stability for agents.

### 2.6 Status vocabulary (no new words)

Mission status: `MISSION_STATUS_LABELS/TONES/ICONS` (Active / Inactive / Terminée / Annulée). Run: `RUN_STATUS_*`. Task: `TASK_STATUS_*` (`agents/labels.ts`). Result: `RESULT_STATUS_LABELS` / `_COUNT_LABELS` (`vocabulary.ts`, À relire / Validé / Rejeté / Remplacé; plural Acceptés / Refusés). Event types: `EVENT_TYPE_*`. A new label needed by one surface goes in that surface's own label file; a label shared by ≥ 2 surfaces goes through the PM (frozen file).

---

## 3. Responsive behaviour

Content width excludes the sidebar (`--sidebar-width` 256 px, collapses to 72 px in the shell). Breakpoints are on **content width**, written as `@media (max-width: …)` in the surface stylesheet (the shell already collapses before 1000 px).

| Region | ≥ 1100 px | 700-1099 px | < 700 px (phone) |
|---|---|---|---|
| List cards | 3 columns (`repeat(auto-fill, minmax(20rem, 1fr))`) | 2 | 1 |
| KPI tiles | one row (`.mui-kpis` auto-fit `minmax(11rem, 1fr)`: 4-5 per row) | 2 per row | 1-2 per row |
| List toolbar (Statut / Type / Tri) | one row, sort right-aligned | wraps | stacked, full width |
| Detail header | icon + title + chips left, actions right | actions wrap under the title | actions become a wrapped row of icon buttons keeping `aria-label`; chips wrap |
| Tabs | full row | scrolls horizontally (already) | same, focus ring visible |
| Stats panels | 12-col feel: Progression + KPI row; then 2-3 panels per row | 2 per row | 1 per row; donut stacks ring above legend (`missionUi.css` ≤ 40 rem) |
| Review table | 7 columns | Source/Publiée/Vérifiée collapse under the row | each proposal stacks as labelled rows (`Avant`, `Proposé`…), checkbox first |
| Dialog | centered, max width ~ 56rem | same | full-width sheet, footer buttons wrap, decision buttons ≥ 44 px |

Rules: no horizontal page scroll (tables and charts scroll inside their own focusable region); touch targets ≥ 32 px (`--control-sm`), primary decisions ≥ 40 px; text never truncated without a `title` or an accessible full text; layout never depends on hover; keep the `Link` card fully clickable while the switch and « … » stay separate focusable controls (they live outside the `<a>`, as today).

---

## 4. Loading, empty, error, unknown states

Principle (`coding-guideline` RULE ZERO): a human must always see that something is running, what, and how to leave. Existing queries are cached and not polled except the overview (15 s) and statistics (`keepPreviousData`).

| State | Rule | Component |
|---|---|---|
| **Loading, first** | Skeleton blocks shaped like the final layout inside a region with `aria-busy="true"` **and** a visible « Chargement… » label (never a lone spinner or blank). KPI tiles show « – » + hidden « (chargement) ». | `.mui-skeleton`, `MissionKpiTile value={undefined}` |
| **Loading, refresh** | Keep the previous data on screen, add « Mise à jour des chiffres… » (statistics already does). No layout jump. | `keepPreviousData` |
| **Empty (nothing exists)** | Honest sentence + next action. List: existing `EmptyState` « Aucune mission » + « Nouvelle mission ». Results: existing empty states. Charts: `mui-state` message. | `EmptyState`, `.mui-state` |
| **Empty (filtered out)** | Say the filter excluded everything and offer « Réinitialiser les filtres ». | surface |
| **Error** | Real cause in French, `role="alert"`, a « Réessayer » button calling `refetch()`. Previous data stays visible when we have it (« Actualisation impossible : dernières données connues affichées »). Never swallow. | `.mui-state[role=alert]` + `Button` |
| **Unknown** (`null`) | « Non renseignée » / « — » + hidden « (indisponible) » + one short reason. Examples: confidence `null`, `last_run_at` `null` → « Jamais exécutée », `source_published_at` `null` → « inconnue », `acceptance_rate` `null` → « — ». |  `MissionKpiTile value={null}` |
| **Unavailable** (no backing data) | Omit the region **or** a tile reading « Indisponible » with the reason in the hint. Never a placeholder number, never 0. List: R2 « Appels API », « Appels / minute », Gantt phases, « 3 agents » count, « Terminées (30 jours) ». |
| **Zero** | A number that is proven zero (counts of existing rows) shows 0, muted. A rate with no denominator is `null`, not 0 %. |
| **Partial** | Show what exists; label the gap (e.g. statistics with sessions but no logs: the log chart says « Aucune entrée de journal sur la période »). |
| **Stale after failed poll** | Keep data, show the existing « Actualisation impossible » line. |

Accessibility: state messages use `role="status"` (informative) or `role="alert"` (failure); focus order unchanged; every icon is `aria-hidden` and the meaning is in text; contrast is covered by `tokens.test.ts`.

---

## 5. File ownership and the hot-file rule

### 5.1 Ownership

**Slice 01 (done, frozen after commit)** owns: `theme/tokens.css` (Mission UI block), `theme/tokens.test.ts` (Mission pairs), `missions/missionAccent.ts`, `MissionStatusChip.tsx`, `MissionKpiTile.tsx`, `MissionPanel.tsx`, `MissionDonut.tsx`, `donutModel.ts`, `donutModel.test.ts`, `missionUi.css`, the Showcase card, this contract.

**Slice 02: Missions list.** Edits: `missions/MissionsPage.tsx`, `missions/MissionsPage.test.tsx`. Creates (prefix `mlist`, flat in `missions/`): `MissionCardTile.tsx` (card + `ActiveSwitch`), `MissionsKpiBar.tsx`, `MissionsToolbar.tsx` (statut/type/tri), `missionsListModel.ts` (+ `.test.ts`: filter, sort, KPI derivation from unfiltered items, progress %), `missionsList.css` (new class prefix `mlist-`). Does **not** delete old `.mission-card*` rules in `missions.css` (Slice 05 does).

**Slice 03: Statistiques.** Edits: `missions/StatsTab.tsx`, `StatsChart.tsx`, `statsModel.ts`, `stats.css`, `StatsTab.test.tsx`. Creates: `StatsProgressPanel.tsx`, `StatsKpiStrip.tsx`, `StatsAgentPanels.tsx` (donut + table), `StatsResultsPanel.tsx`, `StatsActivityPanel.tsx`, `statsSelectors.ts` (+ `.test.ts`: pure selectors from `MissionStatistics`/`MissionOverview`), `statsPanels.css` (prefix `stp-`). Reads `useMissionOverview(missionId)` (shared cache key, no extra polling) for progress/agents KPIs.

**Slice 04: detail shell, overview, results, review.** Edits: `missions/MissionDetailPage.tsx`, `MissionLiveStrip.tsx`, `MissionOverviewTab.tsx`, `ResultsTab.tsx`, `ResultsCard.tsx`, `results.css`, `MissionTabs.test.tsx`, `ResultsTab.test.tsx`; `agents/ReviewDialog.tsx`, `ReviewSummary.tsx`, `ReviewItems.tsx`, `ReviewEvidence.tsx`, `ReviewConfidence.tsx`, `ReviewDecision.tsx`, `review.css`, `ReviewDialog.test.tsx`, `reviewFormat.ts`. Creates: `MissionHeader.tsx` (icon tile, chips, action buttons), `missionDetail.css` (prefix `mdet-`), `ReviewProposalTable.tsx` (replaces the `ItemRow` list layout), `reviewTable.css` (prefix `rvt-`). `agents/agents.css` is shared with the Agents queue: 04 adds **no** review rules there (use `review.css`/`reviewTable.css`).

**Slice 05 (integration):** may delete dead rules from `missions.css` (`.mission-card*`, `.mission-cards*`, `.missions__filters`, `.mission-live*` once unused), run axe/e2e, fix cross-surface visual drift.

**Not owned by 02-04 (frozen, restyle only through inherited tokens):** `ActivityTab.tsx`, `ActivityLog.tsx`, `ActivitySessions.tsx`, `activity.css`, `activityLabels.ts`, `CreateMissionDialog.tsx`, `DeleteMissionDialog.tsx`, `TargetPicker.tsx`, `missionKinds.ts`, `missionTestData.ts`.

### 5.2 Frozen shared files (change only via PM, serialised)

`theme/tokens.css`, `theme/tokens.test.ts`, every Slice 01 file above, `missions/missions.css`, `missions/labels.ts`, `missions/vocabulary.ts`, `missions/resultsLabels.ts`, `api/missions.ts`, `ui/*`, `dev/Showcase.tsx`.

### 5.3 Hot-file rule

1. One file, one owner per row above; a slice never edits a file owned by another.
2. New styles go in the slice's own stylesheet with its own class prefix (`mlist-`, `stp-`, `mdet-`, `rvt-`); `missions.css` is read-only for 02-04.
3. A needed change to a frozen/shared file (a primitive prop, a token, a shared label, `api/missions.ts`) is sent to the PM as a minimal patch request; the PM serialises it. Until then the slice composes around it with its own CSS (e.g. a local variant class), never by forking a primitive.
4. Read-model gaps (see decisions D1, D2) are a PM/Human decision, then one backend + `api/missions.ts` patch, serialised before 05. The UI ships with the explicit « unavailable » rendering meanwhile.
5. Tests: each slice runs only its own focused tests + `tsc`, lint on touched files and the frontend build. The full unit suite and e2e belong to Slice 05.
6. Showcase: a slice that adds a reusable primitive must come back through rule 3; surface-specific components are not added to the showcase.

---

## 6. Decisions and open questions (for PM / Human)

- **D1.** « Terminées (30 jours) »: `MissionCard` has no completion date. Default applied in this contract: tile reads « Terminées » (all time). Alternative: add `completed_at` to the card read model (one column already implied by the status transition?). Needs Human choice before 02 ships.
- **D2.** List « 3 agents »: no count on the card. Default: show `agent_label ?? 'Automatique'`. Alternative: read-model field `agents_count` (distinct agents with a session on the mission).
- **D3.** R2 « Appels API » family and typed Gantt: not backed by telemetry. Default: factual substitutes (journal entries, sessions) or omission; the Human should know these R2 widgets will not appear as drawn.
- **D4.** R2 mixes overview and statistics. Default: Progression + 4 KPI tiles + charts live in **Statistiques** (03); Vue d'ensemble keeps config/runs/tasks (04). Tab set unchanged.
- **D5.** Activity tab (« Journaux » in R2) is not in any slice's scope; it inherits tokens only. Say so if a restyle is wanted.
- **D6.** Card progress « validées » vs overview « traitées » (key fact 2): intentional, labelled differently.
