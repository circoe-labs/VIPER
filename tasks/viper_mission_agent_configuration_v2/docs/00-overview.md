# Overview

## Goal
Turn Missions from a mostly fixed configuration surface into an admin-extensible orchestration system without replacing the shipped Mission/Run/Task/Result, human-review, MCP credential, lease or telemetry architecture.

## Scope
- Configurable mission category catalog seeded from current fixed mission types.
- Reusable instruction-skill library and category defaults.
- External source hierarchy, source descriptions, category associations and evidence-success counters.
- Internal VIPER context sources: typed read-only references to relevant database records supplied to the mission model without conflating them with the work target.
- Mission-specific structured result schema, machine-evaluable objective/completion semantics, `allow_multiple`, omit-unchanged semantics and proposal-first write path.
- Agent identity numbering/reservation, configurable per-owner safety cap, explicit exit/release UX/API semantics.
- Admin navigation and configuration surfaces.
- Voice/conversational mission creation that fills the same mission draft rather than creating a parallel mission path, driven by an editable mission-creator behavior prompt in Settings.
- One-off/recurring mission authoring with per-run objective reset for recurring work.
- Category-owned mission colors/icons.

## Non-goals
- Do not give external agents new tools/capabilities through skills in this task.
- Do not capture chain-of-thought or private reasoning.
- Do not replace Mission -> Run -> Task -> Result.
- Do not replace claim leases, heartbeats, token auth, telemetry sessions or human review with duplicate mechanisms.
- Do not auto-apply mission agent output to business records without the existing review/validation boundary.
- Do not implement full future RBAC; admin-only placement is sufficient for the first product version.
- Do not treat every visited URL as a reusable library source.

## Mental model
A **Category** supplies defaults and visual identity. A **Mission** is a configured instance that may inherit or override those defaults, owns its machine-evaluable objective and generated output contract, and is either one-off or recurring. A **Skill** is reusable instruction text. An **External Source** is reusable research knowledge; evidence records tie concrete facts to concrete URLs and to their root/sub-source. An **Internal Context Source** is a typed read-only reference to an allowed VIPER record whose current read model is supplied as mission context. A **Target** remains the record/item the agent is asked to work on and must not be conflated with supporting context. An **Agent identity** is a token-backed actor instance with lifecycle and owner attribution. An **Agent result** is a structured proposal VIPER interprets and reviews before writing business data.
