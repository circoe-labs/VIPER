# Task 00 — Orchestrate the VIPER V1 implementation

## Goal
Own the task plan, verify repository/source reality, protect private data and execute tasks sequentially without scope drift.

## Context
This handoff was critically reviewed. Read `docs/05-critical-review.md` before trusting the earlier plan. The target repo was public and the real Excel fixture is sensitive.

## Scope
### In Scope
- Read all durable docs and sources.
- Re-check repo state/visibility and current branch.
- Ensure private workbook handling is safe before any code.
- Keep `tasks/TODO.md` statuses current.
- Modify/add/reorder tasks when repo reality requires it, documenting rationale.
- Verify each task acceptance criteria/tests before moving on.

### Out of Scope
- Do not implement feature code merely to “get started”.
- Do not copy the handoff `sources/` folder wholesale into the public repo.
- Do not start future-agent/mail/Calendly scope.

## Dependencies
None.

## Implementation Steps
1. Read TODO, overview, decision log, critical review, data model, Excel mapping, interface/design/security docs.
2. Inspect repo and visibility.
3. Establish local private-source handling; ensure real workbook will not be committed or logged.
4. Reconcile task plan with repo reality.
5. Mark Task 00 complete only when next task is safe and unambiguous.
6. For every later task, verify tests/docs and only then advance status.

## Files Likely Touched
Planning docs, task status files; no feature source expected.

## Architecture Constraints
Orchestrator has authority to change task plan but may not silently change locked product decisions. Preserve user terminology and V1 scope.

## Testing Requirements
Validate handoff consistency, repo state, privacy guardrails and task numbering/dependencies.

## Acceptance Criteria
- Private workbook is protected from public git/CI.
- Next task is clearly identified.
- No contradictory task dependencies remain.
- TODO reflects reality.

## Documentation Updates
Update TODO and relevant task files if plan changes.

## Handoff Notes
Remain in orchestration mode; complete one task at a time.
