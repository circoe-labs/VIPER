# Target architecture

## Existing spine

```text
Mission
  -> MissionRun
    -> AgentTask
      -> AgentTaskResult
```

This remains unchanged as the execution and human-review spine.

## New supervision layer

```text
MissionRun
  -> MissionAgentSession (one per agent participation)
      -> MissionAgentLog (append-only factual events)

AgentTask.claim/heartbeat
  -> touch MissionAgentSession.last_seen_at

AgentTaskResult
  -> review summary / statistics
```

## MissionAgentSession
Recommended fields:
- `id`
- `organization_id`
- `mission_id`
- `run_id`
- `agent_id` (MCP token id)
- `agent_label` snapshot
- `started_at`
- `last_seen_at`
- `ended_at`
- `status`: active / ended / timed_out
- `disconnect_reason`
- optional cached counters only if measurement proves necessary

Constraints:
- a single active session per `(run_id, agent_id)`;
- historical sessions retained after end;
- mission/run relationships must survive normal review history needs;
- session lifecycle must be safe under concurrent claims.

## MissionAgentLog
Recommended fields:
- `id`
- `session_id`
- `mission_id`
- `run_id`
- `task_id` nullable
- `agent_id`
- `event_type`
- `message`
- `source_url` nullable
- `source_published_at` nullable
- `created_at`
- `metadata` JSONB

Suggested event types:
`search`, `source_opened`, `observation`, `verification`, `progress`, `warning`, `error`, `decision_summary`.

## Evidence extension
Existing result evidence is `field + source + quote`, with one global confidence. Extend evidence with:
- `confidence` per evidence/item;
- `source_published_at` nullable;
- `source_checked_at`;
- optional source label/channel only if already justified by the result type.

Proposal normalization must carry these values onto review items so the frontend does not reconstruct them from raw JSON.

## Lifecycle
1. Agent claims a task belonging to a mission run.
2. VIPER resolves the authenticated token and upserts/opens a session for `(run_id, agent_id)`.
3. Claim and heartbeat touch `last_seen_at`.
4. Agent writes meaningful factual logs through a mission-scoped MCP tool; writes also touch the session.
5. Agent submits/fails/releases normally; task lease semantics remain unchanged.
6. Agent may explicitly end its mission session.
7. A maintenance sweep marks active sessions `timed_out` after 3 hours without activity and records a warning event/reason.

## UI read model
Create mission-specific read endpoints rather than forcing the frontend to derive everything from the current detail payload. The API should support:
- compact overview/live state;
- paginated/filterable activity;
- paginated/filterable results;
- aggregated statistics/time buckets.
