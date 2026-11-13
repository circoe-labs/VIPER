# Decision log

## Locked decisions
1. The three supplied UI screens are the **visual source of truth** for the redesign.
2. Repository Mission contracts are the **behavioral source of truth**.
3. Existing `Mission -> MissionRun -> AgentTask -> AgentTaskResult` is preserved.
4. Existing mission telemetry/session/log infrastructure is reused; this task must not rebuild it.
5. Statistics are **mission execution statistics**, not prospecting/commercial statistics.
6. Useful metrics include truthful agent activity, tool/API calls where instrumented, tasks/results, result/review states, errors/warnings, durations and per-agent distribution.
7. Pie/donut charts are appropriate for compact categorical distributions when the underlying categories are mutually meaningful; every chart needs a textual/table alternative.
8. Existing activate/pause/edit/delete and human review semantics must remain intact.
9. Rejection/acceptance remains the human decision boundary; no UI shortcut may auto-apply proposals.
10. Empty/unknown states are shown explicitly rather than inferred or fabricated.

## Corrections to earlier framing
The general VIPER pipeline specification is not the source for Mission statistics. Commercial email/prospecting KPIs must not bleed into this surface.
