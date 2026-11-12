# Decision log

## Locked product decisions
1. Mission detail uses four tabs: **Vue d'ensemble**, **Activité**, **Résultats**, **Statistiques**.
2. Result cards must provide useful summary information before opening review.
3. Review must expose global confidence and per-item confidence.
4. Review must expose source URL, source publication/freshness date when known, and source checked-at date.
5. The rejection reason field is not always visible; request it only after Reject is chosen.
6. Every agent working a mission must produce a factual research/activity report.
7. Mission activity must support multiple agents concurrently.
8. Inactivity for 3 hours ends the mission agent session with a visible warning.

## Locked technical decisions
1. Reuse MCP token identity and existing task claim/heartbeat lifecycle.
2. Do not create a second heartbeat mechanism.
3. Session creation is automatic on claim for mission tasks.
4. Explicit session start/end MCP tools may exist but correctness must not depend on them.
5. Logs are database rows, not filesystem folders.
6. Logs are structured and append-only.
7. Logs must not solicit or persist private chain-of-thought; only factual actions, evidence, observations and progress summaries.
8. Existing `AgentTaskResult` human acceptance path remains authoritative for business writes.
9. Source publication date is nullable and must never be invented.
10. Source checked-at is the timestamp when the agent verified/consulted the source and is distinct from publication date.

## Provisional choices to validate in Slice 00
- Whether mission log reading exposes all agents' logs in the same run or defaults to the caller's session with an explicit shared-run option.
- Final endpoint naming and pagination shapes.
- Exact inactivity sweep integration point (mission scheduler pass vs dedicated maintenance service), provided it does not alter the 15-minute task lease semantics.
- Current workspace Task Type names for Slice dispatch.
