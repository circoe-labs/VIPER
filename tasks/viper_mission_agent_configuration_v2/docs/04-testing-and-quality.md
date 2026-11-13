# Testing and quality

## Per-Slice policy
Implementation slices perform code review plus targeted evidence only: static/type/build checks where warranted, bounded API/UI smoke checks, migration inspection and real agent traces for MCP/prompt/runtime behavior. **Do not run the full unit test suite at individual Slice boundaries.** A focused individual test is permitted to diagnose a specific defect.

## Final phase
Slice 08 owns the complete unit, integration and E2E suites once, together with accessibility/visual checks and real agent-trace validation. Run unit and E2E suites concurrently when isolated resources permit; otherwise run them in the same final validation phase.

## Required scenario coverage
- Existing missions migrate to seeded categories without losing runtime execution semantics.
- Category edits update only mission fields still inherited; explicit overrides remain unchanged.
- Category color/icon is stable and no longer mission-ID-random.
- External source root/sub-source classification and successful-contribution counting distinguish visits from validated evidence.
- Internal VIPER context references resolve only allowlisted records/fields, remain read-only, and are distinguishable from mission targets and external evidence sources.
- Multiple evidence sources can support one result and each receives the correct successful-use increment exactly once.
- Output contract rejects unexpected direct-write shapes, omits unchanged fields and switches single/list envelope based on `allow_multiple`.
- One-off objective completion closes the mission only when its objective is fulfilled; recurring runs reset/snapshot the objective per period and do not terminate the parent mission prematurely.
- Existing recurrence interval/end rules continue to schedule runs; no parallel scheduler is introduced.
- Mission-creator assistant loads the editable Settings prompt, can link external/internal sources, and can set objective + recurrence through bounded draft actions.
- One-target-at-a-time task payloads are enforced for enrichment/targeted work.
- Agent identity numbering distinguishes multiple conversations for one owner and scheduled identities remain reserved.
- Per-owner safety cap defaults to 100 and is not confused with `max_concurrent` tasks-per-token.
- Agent release/end-session semantics work; 3h inactivity timeout still operates and does not strand task leases.
- Voice UI can transcribe, show feedback, ask short clarification, mutate the draft, close safely and create only through normal validation.
- Existing human review remains the only path that applies agent proposals to business data.

## Regression doctrine
Any regression caused by this task is blocking. Attribute it to the responsible Slice, apply a targeted fix/check, then repeat the necessary final gate. Do not convert known regressions into accepted Issues.
