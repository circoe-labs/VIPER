# VIPER — Mission categories, skills, sources, agent identity and voice authoring

## Purpose
Implement the next evolution of VIPER Missions: configurable mission categories, reusable instruction skills, a source knowledge library, mission-specific structured output contracts, clearer agent identity/lifecycle, and a conversational voice-assisted mission creation flow.

## Project
- Project: **VIPER**
- Repository: `circoe-labs/VIPER`
- Canonical runtime model to preserve: `Mission -> MissionRun -> AgentTask -> AgentTaskResult`
- Canonical docs to audit first: `doc/architecture/missions.md`, `doc/architecture/agent-missions.md`, `doc/architecture/mission-telemetry.md`, `doc/architecture/mcp-server.md`
- Existing handoffs to reuse, not duplicate: `viper_mission_ui_redesign_source_truth` and `viper_mission_supervision_agent_telemetry`
- Functional reference bundled under `references/`.

## Product outcome
1. Mission categories are admin-managed data rather than an immutable enum-only product taxonomy. The current prospection/signals/enrichment/verification/other set is seeded as the initial catalog.
2. Each category has name, description, icon, color, general prompt, default instruction skills and default sources. Category defaults continue to flow to a mission only while that mission value remains unmodified; explicit mission overrides are sticky.
3. Skills are reusable **instruction blocks only** in this scope. They do not grant external capabilities or tools.
4. Sources cover two distinct context classes: reusable external research sources (root + optional recurring sub-sources) and read-only internal VIPER context references (for example company/client/prospect records) linked to the mission. External sources keep descriptions, category associations and evidence counters based on successful contributions, not mere visits; internal records are resolved into bounded model context without becoming mutation targets.
5. Each mission computes its own structured JSON output contract. Agents return proposals, never direct business-database writes. Unchanged fields are omitted. `allow_multiple=false` means one result item at a time; true changes the result envelope to a list.
6. Agent labels are human-legible and distinguish concurrent conversations, with numbered identities per owner and stable reserved identity for scheduled agents. A configurable safety cap defaults to 100 agents per person. Existing task concurrency and session timeout semantics are audited and corrected where product wording currently conflates them.
7. Agents can explicitly release work/end their mission session; existing lease release and 3h telemetry timeout must be reused rather than replaced with a parallel system.
8. Mission creation gains an optional voice/conversation mode: black/blurred immersive overlay, live transcription, short agent questions, visible voice feedback, draft-first mission authoring, and explicit user validation unless the user clearly commands creation. The mission-creator assistant has its own editable behavior prompt in Settings, distinct from category worker prompts.
9. Mission authoring exposes one-off vs recurring execution using the existing recurrence model, plus a machine-evaluable mission objective. A one-off mission completes when its objective is fulfilled; a recurring mission creates a fresh per-run objective at each configured interval and remains active until its recurrence end rule.
10. Sidebar navigation is grouped into main/configuration/admin sections; the new category/skills/source management surfaces are admin-scoped.

## Async execution model
Execute `slices/00-project-manager` first. After `READY`, dispatch **01 + 03 + 04 concurrently** when the freshness check confirms no newly introduced hot-file conflict.

- 01 establishes the category/skill domain and migration/API contract.
- 03 owns token identity, numbering, lifecycle and limits.
- 04 owns mission objective/completion semantics plus output-schema generation and one-item-at-a-time proposal semantics.
- 02 follows 01 because category/source persistence shares mission-domain migration/model ownership.
- 05 follows 01+02 and owns admin UI/navigation plus category selection in mission creation.
- 06 follows 05 because both touch the mission creation surface.
- 07 converges backend runtime behavior after 01+02+03+04, while consuming UI work as a soft requirement.
- 08 is the single final integration/unit/E2E/agent-trace convergence gate.

Numbering is presentation/topological order, not a serial execution mandate.

## QA doctrine
Implementation slices use review, type/static/build checks, bounded smoke checks and real agent traces where relevant. They do **not** run the full unit suite as a routine completion gate. Slice 08 owns the complete unit, integration and E2E campaign once, together with final agent-trace validation. Regressions introduced by this task are blocking and must be fixed rather than parked as Issues.
