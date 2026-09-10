# Task 16 — Implement Home global dashboard from real V1 data

## Goal
Create the overall activity/database-health homepage the user requested, with actionable drill-downs and no fake integrations.

## Context
Home should give global visibility first, then next actions. Manual contact tracking now supports response/no-response and appointment metrics.

## Coding Skill Requirement
Before editing code, load and follow `/caveman` and `/coding-guideline` from `~/ai/skills/`.

## Scope
### In Scope
- Database-health KPIs.
- Contact activity: planned/due/contacted/no-response/responses/appointments.
- Lightweight quote/follow-up/won if manually recorded.
- Monthly progress toward contacted/appointment targets when meaningful.
- Next actions.
- Recent import/manual activity.
- Click-through to Prospection filters.
- Clear states for future agent/email/Calendly data being unavailable.

### Out of Scope
- No fake IProspect/IContact.
- No invented mail or Calendly ingestion.
- No heavy BI suite.

## Dependencies
Tasks 14-15; audit core from Task 05.

## Implementation Steps
1. Define aggregate service/KPI formulas.
2. Build cards and next-action list.
3. Add recent activity.
4. Link drill-down filters.
5. Add empty/limited-data states.
6. Test.

## Files Likely Touched
Home route/components, aggregate queries/services, tests.

## Architecture Constraints
KPIs derived from canonical tracking/verification/contactability semantics. Queries explicit/indexed. Target cards are informative, not the sole dominant screen hierarchy.

## Testing Requirements
Aggregate correctness, no-response logic, target progress, drill-downs, empty states, no mocked agent values.

## Acceptance Criteria
- Home answers “où en est l’activité/la base ?” and “quoi faire ensuite ?”.
- Real data only.
- Drill-down works.

## Documentation Updates
Document KPI definitions.

## Handoff Notes
Global visual reference: `../../visuals/neon-command-brand-direction.png`.
