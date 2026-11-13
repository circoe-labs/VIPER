# Target architecture

## Ownership boundaries

### Category + skill catalog
Persist `MissionCategory` and `MissionSkill` (names illustrative; PM must reconcile repository naming). Categories carry visual/product defaults and a stable technical execution mapping where needed. Category-skill and category-source associations are reusable defaults.

### Mission inheritance snapshot/override state
A mission must be able to answer, for each inherited field, whether its current value is still inherited or explicitly overridden. Do not infer this only by comparing strings after the fact. Use explicit override metadata/columns or an equivalent durable mechanism.

### Source knowledge, internal context and concrete evidence
Separate:
- reusable external **source root** (LinkedIn, Hunter.io);
- optional external **sub-source** (LinkedIn > Jobs);
- typed read-only **internal context reference** to an explicitly allowed VIPER entity/record (for example a company, client or prospect card);
- concrete **evidence citation** for externally observed facts (actual URL, observed/check date, fact/result association);
- source effectiveness aggregate (successful contribution count) for evidence-producing external sources.

Keep `MissionTarget` semantics separate from internal context. A target is the subject to process. An internal context source is supporting data. Resolve internal references at claim/runtime through allowlisted read models and fields so the agent gets current relevant context without arbitrary SQL/table access or a new direct-write path.

Existing `mission_sources` data must be migrated or compatibility-adapted without silently losing mission links. Internal context references may use a separate typed association if forcing them into the URL source table would blur these semantics.

### Mission objective + output contract
A mission owns a machine-evaluable objective in addition to its output shape. Reuse the shipped recurrence scheduler (`is_recurring`, interval/start/end fields) rather than inventing another periodic system. A one-off mission closes when its objective is fulfilled. For recurring work, each `MissionRun` snapshots/instantiates the objective for that period and tracks its own progress; the parent mission stays active for the next interval until the existing recurrence end rule is exhausted or the mission is otherwise closed. `result_limit` remains a cap unless explicitly reconciled as the same concept.

On mission save/update, generate/store or deterministically derive a versioned JSON Schema-like contract from mission configuration. The contract exposed to the agent must:
- identify one target when the task is target-bound;
- define only writable/proposable fields relevant to the task;
- instruct omission of unchanged values;
- carry evidence/source requirements;
- wrap one item by default, list only when `allow_multiple=true`;
- permit bounded notes/metadata without becoming an arbitrary database mutation channel.

The server validates submitted output against the contract, normalizes/diffs it, and produces the existing review proposal. Agent direct domain writes must not be introduced as the mission execution path.

### Agent identity
Continue using `McpToken` as the authenticated machine principal. Add durable owner-relative instance identity/numbering and reservation semantics rather than creating a parallel agent-principal table unless repository constraints require one. Scheduled identity reservation must survive idle periods. Interactive number reuse must be deterministic and auditable.

### Mission-creator assistant and voice authoring
The mission-creator assistant has a dedicated editable behavior/task prompt stored through the existing Settings/configuration pattern, with a built-in default and human-editable override. It is distinct from category worker prompts and mission instructions.

Voice is an alternate input adapter over the ordinary mission draft. Speech-to-text may use a local Whisper-compatible implementation. The conversational model receives bounded tools/functions that edit draft state (name, category, prompt, skills, external sources, internal context references, objective, recurrence and other mission options) rather than directly bypassing UI/domain validation.

## Reuse constraints
- Reuse token auth, capabilities, task lease/release, session telemetry and audit.
- Reuse existing mission create/update endpoints or factor a shared service used by both form and voice authoring.
- Reuse human review/apply services.
- Reuse current mission telemetry factual-log policy.
- Reuse current Mission UI redesign components where shipped; do not reintroduce pre-redesign layouts.
