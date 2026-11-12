# Testing and quality

## Required automated gates
- backend unit/service tests for session creation, heartbeat touch, timeout, concurrent claims and log validation;
- migration tests/current migration suite;
- API tests for authorization, pagination, filters and aggregates;
- result-schema tests for old and new evidence payloads;
- frontend unit tests for tab navigation, states, cards and reject flow;
- end-to-end flow: create/run mission -> agent claim -> logs/heartbeat -> submit -> result appears -> review accept/reject -> statistics update;
- accessibility checks for tabs, status feedback, modal focus and charts/alternative text.

## QA doctrine
Every implemented Slice gets baseline `qa-verification`. Code changes add `code-review`. User-visible/runtime behavior adds `runtime-validation`. Agent prompts/tools/runtime changes add `agent-trace-analysis` with real trace evidence.

A regression caused by the current Slice is blocking. It cannot be deferred to `Issues/`.

## Human validation
Human checks happen after maximum reasonable machine validation. Required checks focus on UX comprehension, information hierarchy and whether the supervision flow answers: "what are my agents doing now, what needs my attention, and what happened over time?"
