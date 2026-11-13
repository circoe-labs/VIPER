# Decision log

## Locked
1. Seed, do not discard, the current mission categories.
2. Product categories become persisted/configurable; do not keep the UI taxonomy permanently bound to `MissionType` enum values.
3. Preserve an internal technical routing discriminator if task generation needs one. Product category and task-execution semantics do not have to be the same column.
4. Category fields: name, description, icon, color, general prompt, default skills, default sources.
5. Result schema belongs to mission configuration and is generated on mission save/update.
6. Skills are instruction text only.
7. Inheritance is field-level: untouched/default values track category changes; explicit mission overrides stop tracking.
8. `allow_multiple=false` by default; output one item at a time. `true` changes the result envelope to a list.
9. Unchanged fields are omitted, not resent as null or cosmetically rewritten.
10. Agent mission output is proposal data. VIPER normalizes/interprets/applies only after the existing review boundary.
11. Source counters measure successful contribution/validation, not visits or mission attachment count.
12. Source library is hierarchical root + optional recurring sub-source. Evidence keeps concrete cited URL(s).
13. Multiple sources may support one fact; all successful source contributions count.
14. Current `max_concurrent=3` is not a token cap. Introduce a separate per-owner identity/token safety cap, default 100.
15. Existing telemetry timeout remains 3 hours unless a later explicit product decision changes it.
16. Reuse `viper_release_task` and telemetry `end_session`; add a coherent “leave work/mission” contract instead of a second lifecycle system.
17. Scheduled agents reserve stable numbered identity; transient conversational agents can reuse vacant identity numbers after deactivation/revocation according to a deterministic allocation rule.
18. Voice assistant creates/edits the same mission draft used by the form, may ask clarifying questions, and remains human-validatable.
19. Category color/icon becomes the mission's visual identity; status remains separately encoded.
20. Admin config lives in an admin navigation section; future fine-grained permissions are out of scope.
21. Mission sources have two classes: external research sources and internal VIPER context references. Internal context references are read-only and may link relevant company/client/prospect or other explicitly allowed business records into model context.
22. A mission target is not the same thing as an internal context source: target = what the agent must process; internal source = supporting data supplied to do that work.
23. The mission-creator assistant has its own editable behavior/task prompt in Settings, distinct from category `general prompt` and worker skills. Reuse the existing Settings prompt/configuration pattern rather than hard-coding it in the voice component.
24. The mission-creator assistant can attach both external sources and relevant internal VIPER context records to the draft.
25. Reuse existing mission recurrence fields for one-off vs recurring execution and interval/end rules; do not build a second scheduler.
26. Add a machine-evaluable mission objective/completion contract. For one-off missions, the mission becomes complete when the objective is fulfilled. For recurring missions, each `MissionRun` receives a fresh objective instance for that period; fulfilling one run does not terminate the recurring mission unless its existing recurrence end rule is also exhausted.
27. Keep `result_limit`/execution caps distinct from objective semantics unless repository/product reconciliation proves they are the same concept.

## Repository constraints
- Current `MissionType` is a fixed `StrEnum` and is used by mission runnable/task-generation code. Migration must avoid breaking task routing.
- Current source model is exact-URL unique by organization. Introduce root/sub-source/evidence without losing existing mission links.
- Existing review system already embodies the “agent proposes, person decides” doctrine; extend it rather than bypass it.
- Mission telemetry explicitly forbids reasoning capture and already tracks factual logs/sessions.
- The repository already has editable AI-prompt UI/configuration patterns (`frontend/src/settings/PromptSection.tsx` and settings/integration/app-setting services); mission-creator prompt configuration should follow that pattern rather than add a one-off storage mechanism.
- Missions already persist recurrence controls (`is_recurring`, interval count/unit, start/end rules) and `result_limit`; the new work is objective/completion semantics and creator-agent manipulation of those fields, not a replacement scheduler.
- `MissionTarget` already links company/prospect work subjects; internal context sources must not silently redefine that existing target contract.

## Open detail to reconcile
- The product owner started a requirement as "un nombre maximum de…" without completing the noun. Do **not** invent a new maximum field. During Slice 00/04, first check whether the intended control is the existing `result_limit` / per-run cap. If not semantically equivalent, surface a targeted product decision before adding another maximum concept.

- **Resolved (Slice 04, confirmed in Slice 08):** the "nombre maximum" control is the existing `result_limit` (1..500, default 20). No new maximum field exists. The objective count may not exceed it. Product owner confirmation still requested (see LOG.md).
