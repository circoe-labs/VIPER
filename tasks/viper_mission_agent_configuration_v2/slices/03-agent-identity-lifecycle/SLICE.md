# Slice 03 — Agent identity, numbering, limits and lifecycle

## Goal
Make authenticated agent instances human-identifiable and scalable per owner, distinguish task concurrency from token count, reserve scheduled identities and expose a coherent leave/release lifecycle using existing mechanisms.

## Context
`McpToken.max_concurrent` defaults to 3 and limits simultaneous claimed tasks per token. It is not a three-token-per-user cap. Telemetry already provides `end_session`; MCP already provides `viper_release_task`; inactivity timeout is 3 hours.

## Canonical Concepts
McpToken, owner_email, provider, mode, capabilities, claim/release, mission agent session, 3h timeout.

## Scope
### In Scope
- Owner-relative agent instance numbering and display label convention: provider + owner attribute/display + `#N`.
- Deterministic allocation of vacant numbers for transient interactive agents.
- Stable reserved number/identity for scheduled agents.
- Configurable safety cap on agent identities/tokens per owner, default 100.
- Clear separation of this cap from `max_concurrent` tasks-per-token; preserve or explicitly product-configure task concurrency.
- Coherent MCP/API behavior for an agent to release current task(s) and end its mission session cleanly.
- Ensure session timeout/release behavior cannot strand active work.
- Admin/read models display resolved identity.
- Audit/doc updates.

### Out of Scope
- New identity provider/auth protocol.
- Replacing token auth with conversation IDs.
- Changing 3h timeout without an explicit later product decision.

## Dependencies
### Hard `depends_on`
- Slice 00 must be `READY`.

### Soft `requires`
- Slice 07 mission runtime integration: need final semantics for mission-level “leave” aggregation across tasks; fallback is a service method composing existing task release + session end. Mandatory before Slice 08.

### Can Start With
`McpToken`, OAuth token minting, `agent_missions.release`, `mission_telemetry.end_session`, token settings UI/API.

### Produces
Identity allocation/reservation contract, per-owner cap, labels/read models and lifecycle service/tool behavior.

### Integration Checkpoint
Before Slice 07 runtime convergence and final E2E.

## Implementation Steps
1. Audit all token creation paths (OAuth, settings, CLI) and define a single allocator.
2. Add durable owner-relative instance number/reservation metadata or an equivalent collision-safe mechanism.
3. Derive human display label consistently without losing user-configurable descriptive labels if they remain useful.
4. Enforce default per-owner cap 100 with configurable setting and meaningful error.
5. Keep `max_concurrent` as task-concurrency concept; update wording/UI/tool errors to avoid token-limit confusion.
6. Expose/compose “leave work” behavior from existing release/end-session primitives and make it idempotent.
7. Verify timeout sweeps and task lease expiry remain independent and safe.

## Files Likely Touched
MCP token model/migration/services, OAuth/settings routes, MCP tools, telemetry/lifecycle services, agent read models/docs.

## Architecture Constraints
- Reuse existing agent principal/token model unless repository audit proves it insufficient.
- Never rely solely on a model remembering to log off; timeout remains fallback.
- `/caveman` and `/coding-guideline` required.

## Automated Validation
Concurrency-safe allocator smoke, cap enforcement smoke, release/end-session real MCP trace, timeout interaction inspection. Do not launch the full unit test suite at this Slice boundary.

## Acceptance Criteria
- Three concurrent ChatGPT conversations for one owner are distinguishable as separate numbered agent instances.
- Scheduled agent identity/number remains reserved across idle periods.
- Default owner cap is 100 and is not conflated with task `max_concurrent`.
- Agent can explicitly leave/release without waiting for timeout.
- 3h inactivity timeout remains functional.

## Documentation Updates
Update MCP/telemetry docs with identity numbering, cap and lifecycle wording.

## Handoff Notes
Return real trace evidence showing identity and release behavior.
