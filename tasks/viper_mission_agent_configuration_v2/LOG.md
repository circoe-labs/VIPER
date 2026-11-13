# Runtime implementation log

## Slice 00 — PM readiness (2026-11-13, host CLARICE)
Origin: remote handoff found in Drive `to-do` (folder 1EwnK-_UUs78s9nqdKbxZBTEvrZTV7mJs). Connector cannot move folders, so the Human must move it to `current` (no `current` folder known). No docs/workflows/AGENT_TASK_LIFECYCLE.md in repo: fallback = memory Drive IDs, base branch `main`. Mirrored locally under tasks/ (binary references/mission-create-current.png not downloadable; skipped).
Branch: `task/viper_mission_agent_configuration_v2` from main @1602285.

Freshness audit (backend/app, frontend/src):
- Confirmed: `MissionType` StrEnum (models/enums.py), `McpToken.max_concurrent` (default 3, enforced api/mcp.py claim), `viper_release_task`, telemetry `SESSION_INACTIVITY_TIMEOUT=3h` + end_session (services/mission_telemetry.py), recurrence fields + `result_limit` on Mission, `MissionSource`(exact URL unique per org) + `MissionSourceLink`, `MissionTarget`, `frontend/src/settings/PromptSection.tsx`.
- Drift: mission_sources already shipped (migration 0046 is alembic head; main merged lucie work). Slice 02 must evolve it, not create it. Migration filenames in git: 0039..0046.
- Open detail "nombre maximum de…": `result_limit` (1..500, default 20) exists; Slice 04 must check equivalence first, no new max field.
- Hot-file collision risk for 01/03/04: models/missions.py, models/__init__.py, agent_payloads.py, migrations.
  Rule: pre-assigned linear alembic chain: S1 = 0047 (down 0046), S3 = 0048 (down 0047), S4 = 0049 (down 0048). Each slice works in its own git worktree; orchestrator merges in order 01,03,04 and fixes chain/conflicts. Slices must keep migrations independent of each other's tables.

Readiness: **READY**. Dispatch 01 + 03 + 04 concurrently (worktree isolation).

## Slice 03 - Agent identity/lifecycle (2026-11-13)
Implemented in a worktree (migration 0048, down_revision 0047; 0047 belongs to Slice 01 and is absent from that tree, so the chain resolves only once 01 is merged first). Contract: doc/architecture/mcp-server.md section 4.9.
- mcp_tokens.instance_number + live partial unique index; allocator services/agent_identity.py (lowest vacant number per owner+provider, advisory lock); cap = Settings.mcp_max_agents_per_owner (env VIPER_MCP_MAX_AGENTS_PER_OWNER, default 100), 409 agent_cap_reached; no app_settings key (avoids the known_key constraint hot spot with Slice 01).
- actor_for display is now the identity label (ChatGPT lucie #2); label kept as descriptive name. Existing test expectations on actor display updated.
- viper_leave_work (MCP) / agent_lifecycle.leave_work: release all held tasks + end own sessions, idempotent, optional run scope.
- Timeout/lease independence covered by test; 3h timeout untouched.

## Orchestrator — merge of 01/03/04 (2026-11-13)
Merged in order 01, 03, 04 on the task branch (conflicts only additive, in routes/missions.py, services/missions.py, test_mission_supervision.py; both sides kept). Alembic head = 0049, linear. Targeted suites (categories, identity, output, missions, supervision, mcp*, agent_missions, telemetry, runtime_settings) pass on merged tree. `test_migrations.py` has 3 failures (check-constraint match, updated_at trigger, FK index: warehouse tables) that are IDENTICAL on `main` → pre-existing, not ours.
Product decision to confirm with Human: `result_limit` = the "nombre maximum" cap (Slice 04 conclusion). Behaviour change: one-off missions now close `done` when run objective met.
Next: dispatch 02 (needs 01). 05 needs 01+02; 07 needs 01+02+03+04.
