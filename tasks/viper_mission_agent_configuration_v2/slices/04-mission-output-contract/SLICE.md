# Slice 04 — Mission objective, completion and structured output contract

## Goal
Define machine-evaluable mission objective/completion semantics and generate/enforce a mission-specific result contract so agents submit structured proposals one item at a time by default, omit unchanged fields and never need direct business-database mutation for mission execution.

## Context
Existing agent result schemas and review already normalize proposals, while Missions already expose recurrence fields (`is_recurring`, interval/start/end rules) and a per-execution `result_limit`. Product wants one explicit output contract returned with the claimed task plus an objective that VIPER can use to decide whether a one-off mission/run is actually complete. Recurring missions reuse the current scheduler and satisfy a fresh objective each period.

## Canonical Concepts
Agent task payload, AgentTaskResult raw/proposal, claim/submit, review/apply, evidence/confidence.

## Scope
### In Scope
- Mission field(s) for `allow_multiple`, machine-evaluable objective/completion metadata and versioned/derived output-contract metadata as appropriate.
- Reuse existing one-off/recurrence fields and scheduler; define objective snapshot/progress at `MissionRun` level for recurring work.
- One-off mission completion when its objective is fulfilled; recurring run completion when that period objective is fulfilled without closing the parent mission unless recurrence termination is exhausted.
- Keep `result_limit` as a cap unless Slice 00/product reconciliation proves the unfinished "nombre maximum de…" requirement means the same field.
- Deterministic output-schema generator from mission/task/target configuration.
- Single-item envelope by default; list envelope only when `allow_multiple=true`.
- One target per targeted enrichment/update task payload.
- Explicit “omit unchanged fields” semantics; absent field means no proposed change.
- Evidence/source references per item and bounded notes.
- Submission validation against the task/mission contract.
- VIPER normalization/diff/review remains the write boundary.
- Completion/failure result semantics for “cannot find” without fabricating data.
- Objective progress derived from accepted/valid work state, not model self-assertion that the goal is complete.
- MCP claim payload exposes schema/contract clearly.

### Out of Scope
- Source-library persistence/counters (Slice 02).
- Admin UI editor (Slice 05).
- Voice mission authoring (Slice 06).

## Dependencies
### Hard `depends_on`
- Slice 00 must be `READY`.

### Soft `requires`
- Slice 01 category model: need final category technical mapping for schema selection; fallback to existing `MissionType`/task type. Mandatory before Slice 07.
- Slice 02 evidence model: need final evidence reference IDs; fallback to URL/label/check-date fields in result contract. Mandatory before Slice 07.

### Can Start With
Existing `agent_payloads`, mission task generation, MCP `viper_claim_task`, result submit/review contracts.

### Produces
Versioned mission output-contract generator/validator and claim/submit behavior.

### Integration Checkpoint
Before Slice 07 runtime convergence.

## Implementation Steps
1. Inventory existing per-task result schemas and write paths.
2. Define a mission-output envelope that maps to existing proposal normalization instead of arbitrary SQL/domain writes.
3. Define a typed, machine-evaluable objective contract derived from mission configuration and map it to current target/result semantics.
4. Define run-level objective snapshot/progress so recurring runs reset per interval and historical runs remain immutable.
5. Generate schema from mission/task target and expected fields.
6. Enforce absent/omitted fields as “no change”; distinguish explicit clearing only where domain policy allows it.
7. Add `allow_multiple` behavior and prevent accidental arrays when false.
8. For targeted work, ensure one target is exposed per task even if a mission contains many targets.
9. For discovery work, submit one completed item then claim/continue unless batching is explicitly enabled.
10. Add explicit not-found/blocked completion outcomes that do not invent data.
11. Compute objective progress from server-side task/result/review state and expose schema/objective in claim payload with versioned validation.

## Files Likely Touched
Mission model/migration, agent payloads/results, MCP claim/submit handlers, review normalization/docs.

## Architecture Constraints
- Human review remains mandatory before business writes.
- Do not make `null` a universal “unchanged” marker; omission is the default no-change signal.
- Do not expose chain-of-thought fields.
- `/caveman` and `/coding-guideline` required.

## Automated Validation
Schema-generation smoke, single-vs-list validation, unchanged-field diff smoke and real claim/submit trace. Do not launch the full unit test suite at this Slice boundary.

## Acceptance Criteria
- Agent gets an explicit result schema with each relevant claimed task.
- Unchanged name/value omission yields no proposal diff.
- `allow_multiple=false` rejects multi-item output; true accepts the documented list form.
- A one-off mission does not finish before its objective is met.
- Each recurring run receives/satisfies its own objective and the parent mission remains scheduled until its recurrence end rule is exhausted.
- `result_limit` is not silently repurposed as the objective unless explicitly reconciled.
- Result remains reviewable proposal data, not a direct business write.

## Documentation Updates
Update agent mission/MCP docs with the generated output contract and omission semantics.

## Handoff Notes
Publish stable result/evidence interface details to Slices 02 and 07.
