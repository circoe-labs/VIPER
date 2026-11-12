# Agent claim queue is not organization-scoped (pre-existing)

`agent_missions.claim` selects the next pending `agent_tasks` row with no organization filter (`AgentTask` has no
`organization_id`; only `Mission` and `McpToken` do). A token of organization B can therefore claim a task of an
organization A mission, and the telemetry session/logs it then writes attach to A's mission (the read routes
stay correct: they scope by the mission's organization). Not introduced by this task (the claim path predates it)
and the pilot runs a single organization (CIRCOE), so non-blocking.

Suggested fix (own task): filter the claim queue through `runs -> missions.organization_id = token.organization_id`
(thread tasks through `agent_threads.organization_id`), with an isolation test for `viper_claim_task` and
`viper_task_queue`.
