# Planning session — reconstructed

This file reconstructs the product decisions made in the planning conversation that generated this task.

## Locked product decisions
- Mission card colors must encode mission category consistently, not hash mission IDs randomly.
- Mission categories are configurable. Seed the current categories (`prospection`, `signals`, `enrichment`, `verification`, `other`) as the initial catalog; admins may add, edit or remove categories later.
- Category configuration includes at least: name, icon/logo, color, description, general prompt, default instruction skills and default sources.
- The result format is **not** a category field. It is computed per mission from that mission's configuration.
- Skills are reusable instructions, not capability/tool grants in this scope.
- A category's defaults remain inherited only while the mission has not modified that value. Once a mission explicitly overrides a defaulted value, future category edits must not overwrite that mission override.
- Sources are reusable root entities such as LinkedIn or Hunter.io, with optional recurring sub-sources such as LinkedIn > Jobs. Individual visited URLs do not each become top-level source-library records.
- A source usage counter increments only when the source actually contributed to finding or validating an information item. If three sources confirm the same fact, all three increment and the fact's confidence may increase.
- A human/admin may add manual sources and descriptions explaining why/when a source is useful.
- Mission outputs are JSON proposals interpreted by VIPER. Agents should not directly mutate the business database for mission execution.
- Omit unchanged fields from the agent result. Do not resend/rewrite values merely to preserve them; this prevents cosmetic rewrites such as punctuation/hyphen changes from being mistaken for data changes.
- Default work granularity is one completed information/result item at a time. For enrichment, VIPER gives the mission context plus one target. For discovery without predefined targets, the agent still submits one completed item before the next. A mission flag `allow_multiple` may explicitly permit batch output, switching the JSON result envelope to a list.
- VIPER should determine completion from task/result state rather than relying only on the agent claiming it is finished.
- Agent authentication labels should identify provider + person/attribute + numbered instance (e.g. `ChatGPT · <owner> #1`). Numbered concurrent conversations must be distinguishable.
- Scheduled agents reserve a stable identity/number; transient interactive conversations may reuse a vacant number after the previous identity is no longer active.
- Introduce a configurable safety cap of 100 agent identities/tokens per person by default. This is distinct from the existing `max_concurrent=3` tasks-per-token guard.
- Existing code already supports task release and session ending; expose/clarify this as a clean way for an agent to leave work. Existing telemetry timeout is 3 hours, not 1 hour.
- Voice mission creation is draft-first and user-validatable. The assistant may ask short clarifying questions. A clear command such as “vas-y”, “c'est bon”, or “crée-la” may bypass further clarification and finalize creation.
- Voice UI: black/blurred immersive surface, large close control top-left, user transcription in blue toward the bottom, assistant reply in white around the upper-middle/first-third area, large readable type, voice/wave orb bottom-right.
- Sidebar should be grouped into a main section, configuration section, and admin section. Database, agent history, category/skills/source management belong in admin for now. Fine-grained permissions can evolve later.

## Repository corrections discovered during planning
- Current mission card accent is derived from mission ID (`accentForMission(card.id)`), explicitly documented as decoration rather than category meaning. This must change to category-owned color.
- Current `MissionType` is a fixed `StrEnum`; product taxonomy must become persisted configurable data while preserving any internal technical routing still needed by task generation.
- `mission_sources` already exists but is exact-URL based and reports `missions_count`, not successful-evidence contribution count.
- The current Skills panel is mainly agent selection; no reusable instruction-skill library exists yet.
- `McpToken.max_concurrent` defaults to 3 **tasks per token**, not 3 tokens per user.
- Mission telemetry already implements explicit `end_session` plus a 3-hour inactivity timeout; task release also exists through `viper_release_task`.

## Amendment — sources internes, prompt créateur, objectif et périodicité

Le product owner précise que les « sources » d'une mission ne sont pas uniquement des sources web/répertoires. Une mission peut aussi recevoir comme contexte des données déjà présentes dans VIPER (par exemple fiches client, société, prospect ou autres enregistrements pertinents). Ces références internes doivent être liées à la mission et données au modèle comme contexte, sans être confondues avec la cible à traiter.

L'agent qui aide à créer une mission doit avoir son propre prompt de comportement/tâche, administrable dans les paramètres avec les autres prompts d'agents. Ce prompt est distinct du prompt général d'une catégorie, qui concerne le travailleur exécutant la mission.

La création de mission doit également piloter la périodicité : action unique ou récurrente, intervalle/répétition et objectif. Pour une action unique, la mission est terminée lorsque l'objectif est atteint. Pour une mission récurrente, l'objectif est à remplir à chaque période ; VIPER réutilise sa mécanique de récurrence existante et recrée/snapshotte l'objectif au niveau du run.

Le product owner a commencé une phrase « un nombre maximum de… » sans préciser l'objet. Le handoff interdit d'inventer un nouveau champ : le PM doit d'abord vérifier si cela désigne le `result_limit` existant avant toute extension.
