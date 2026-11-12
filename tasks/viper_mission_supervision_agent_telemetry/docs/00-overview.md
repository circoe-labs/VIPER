# Overview

## Goal
Turn the Mission detail page into an agent supervision console that lets the user understand current work, review results quickly, and inspect mission performance without scrolling through a long page.

## In scope
- mission-scoped agent sessions and factual activity logs;
- automatic session lifecycle tied to existing task claim/heartbeat mechanics;
- 3-hour inactive-session timeout;
- per-evidence/per-review-item confidence and source date metadata;
- mission supervision API endpoints and aggregates;
- tabbed Mission detail UI;
- Overview live feedback;
- Activity tab;
- Results tab;
- Statistics tab;
- redesigned review dialog and reject-on-demand reason flow;
- documentation and tests.

## Non-goals
- changing the separation of IProspect, VIPER and IContact;
- autonomous application of agent proposals;
- storing hidden chain-of-thought;
- replacing task leases with session timeouts;
- rebuilding the mission scheduler;
- adding automated LinkedIn navigation/collection;
- turning VIPER into a generic observability platform.

## Mental model
`Mission` is the persistent instruction. `MissionRun` is one execution. `AgentTask` is one unit of work. `AgentTaskResult` is the human-reviewable proposal. A new `MissionAgentSession` represents one agent's participation in one mission run; `MissionAgentLog` represents append-only factual activity during that participation.
