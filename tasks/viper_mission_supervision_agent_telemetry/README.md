# VIPER — Mission supervision, agent telemetry and review UX

## Purpose
This handoff implements the redesign of the VIPER Mission detail experience so that the primary user task becomes supervising agent work rather than scrolling through a one-page mission record.

The work extends the existing mission architecture instead of replacing it. The repository already models `Mission -> MissionRun -> AgentTask -> AgentTaskResult`, agent identity, claims, leases and heartbeats. The target adds mission-scoped agent activity sessions/logs, richer result evidence, supervision APIs, and a tabbed Mission UI.

## Project
- Project: **VIPER**
- Repository: `circoe-labs/VIPER`
- Functional source of truth used in planning: `Cahier_des_charges_pipeline_prospection_IA_v2_SOURCE_DE_VERITE.md`
- Canonical repository docs: `doc/architecture/missions.md`, `doc/architecture/agent-missions.md`

## Product outcome
The Mission detail page becomes a supervision console with four tabs:
1. **Vue d'ensemble** — compact mission summary, configuration and live status feedback.
2. **Activité** — live/recent agent sessions and factual research logs.
3. **Résultats** — review queue cards with summaries and direct opening of the validation dialog.
4. **Statistiques** — chronological and aggregate mission activity metrics.

The review dialog is redesigned to expose global confidence, per-item confidence, source URL, source publication/freshness date when available, source check date, and an agent research report. Rejection reason is requested only after the user chooses Reject.

## Architecture doctrine
- VIPER remains the human validation/control plane. It must not absorb IProspect/IContact business responsibilities.
- No agent result is auto-applied. Existing human review remains mandatory.
- Reuse existing token identity, claim, lease and heartbeat mechanisms.
- Do not create a parallel agent identity or heartbeat subsystem.
- Agent activity logs are factual, audit-friendly events; they must not request or store private chain-of-thought.
- Mission session integrity must not depend on a model remembering to call `register()` or `log_off()`.
- Active mission sessions are created automatically when an agent claims a mission task; explicit start/end tools are optional control surfaces.
- A session becomes timed out after 3 hours without mission activity and records a warning/reason.
- Logs are append-only structured database records, not filesystem folders.

## Execution
Start with `slices/TODO.md`, then execute `00-project-manager` yourself. No implementation slice may be dispatched until Slice 00 reaches `READY`.

## QA doctrine
Every implemented Slice gets:
- baseline `qa-verification`;
- `code-review` for code changes;
- `runtime-validation` for user-visible/runtime behavior;
- `agent-trace-analysis` with real trace evidence for agent prompts, MCP tools, routing or agent runtime changes.

A regression introduced by the current Slice is blocking and may not be parked in `Issues/`. Human validation never substitutes for machine QA.
