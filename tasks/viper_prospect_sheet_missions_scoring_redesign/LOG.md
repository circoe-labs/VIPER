# Runtime implementation log

## S0 — Project Manager readiness (2026-11-18, host CLARICE)

**State: READY.**

Fallback used: `docs/workflows/AGENT_TASK_LIFECYCLE.md` is absent; Drive queue IDs and base branch `main` come from project memory.
The handoff was mirrored from Drive `to-do` (folder 1nejGqaD9yLF2dHBQtQmnuVKZV_RWm0EN) into `tasks/`. The Drive connector cannot move folders, so the Human must move it to `current`. The PNG reference was supplied by the Human.
Branch: `task/viper_prospect_sheet_missions_scoring_redesign` from `main` (dde6123).

### Audit evidence
- `main` already has `person_links` (scored 0-100 links prospect<->member, commit 411218c), `services/person_links.py` (`graph()`, `links_of`), `ProspectLinksCard.tsx`. No path/proximity scoring exists on `main`.
- `prospect_score.py` on `main` has no graph input today: commercial-fit-only holds; Slice 04 must keep it that way and document it.
- Overlap decision (`viper_prospect_intelligence_graph_scoring_followups`): its branches (`task/prospect-intelligence-graph-scoring`, `task/pi-s5/6/7`) are 232 commits behind `main`, unmerged, and build a different graph (`services/relationships/graph.py`, company intelligence) that also edits `prospect_score.py`. They are NOT reused. This task owns the single canonical proximity service over `person_links` (Slice 03); the "path-based reachability scoring" item of the older handoff is superseded by it and must not be merged in parallel. Slice 03 must not touch `prospect_score.py`.
- Hot files: `ProspectEditor.tsx`, `prospects.css`, `frontend/src/api/prospects.ts`, prospect read model/routes.

### Ownership
- S1 owns `ProspectEditor.tsx` top-level shell, header, indicator strip, and shared layout primitives/CSS.
- S6 owns Suivi child components only (TrackingSection, ProspectNotes, SequenceSection, Alerts/Provenance/History) and a separate CSS file; no edits to `ProspectEditor.tsx` beyond what S1 exposes (integration at S7).
- S2 owns `prospect_data_quality.py`, `DataQualityCard.tsx`. S3 owns new proximity service/route/card. S4 owns `prospect_score.py`, `ProspectScoreCard.tsx`. S5 owns new `ProspectMissionMenu` and mission factory.
- Each slice adds its own API types in a new file when possible, to avoid conflicts in `api/prospects.ts`; S7 reconciles.

### Dispatch set
01, 02, 03, 04, 05, 06 in parallel in isolated worktrees; 07 after all six.
Testing doctrine kept: no full suites before S7.

## S7 — Integration (2026-11-18, host CLARICE)
Wired: strip slots (completeness from `data_quality`, proximity from its endpoint), `ProspectScoreCard` `prospectId` + `onScoreChanged`, header `Mission` / `Contacter`, `ProspectContextMenuSurface`, reassess preset -> S4 command. Removed: `COMPLETENESS_FIXTURE`, `PROXIMITY_FIXTURE`, stub hooks, `DataQualityCard`, `ProximityScoreCard`, their CSS, `.prospect-editor__tracking-summary`. Fixed visible defects found on screenshots: Suivi appointment date/time overlap, indicator strip stacking at 800 px. New E2E `frontend/e2e/prospect-sheet.spec.ts`. Test campaign results: see the S7 final report.
