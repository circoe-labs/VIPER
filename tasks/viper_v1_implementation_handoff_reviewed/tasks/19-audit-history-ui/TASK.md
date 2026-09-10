# Task 19 — Expose focused recent history and provenance

## Goal
Make who/what/when/source visible on prospects/companies without creating a heavy audit product.

## Context
Core audit already exists from Task 05. This task is only the user-facing history/provenance presentation and Home activity integration.

## Coding Skill Requirement
Before editing code, load and follow `/caveman` and `/coding-guideline` from `~/ai/skills/`.

## Scope
### In Scope
- Prospect recent history timeline/section.
- Company recent history if cheap/relevant.
- Human/import/future-agent actor labels.
- Source/provenance summary.
- Home recent activity feed using same data.

### Out of Scope
- No rollback engine.
- No raw compliance log UI.
- No infinite event taxonomy.

## Dependencies
Tasks 05, 07, 15-16.

## Implementation Steps
1. Build readable event formatter.
2. Add prospect/company history views.
3. Add provenance summary.
4. Connect Home recent activity.
5. Test ordering/content privacy.

## Files Likely Touched
History/provenance UI, formatter, tests.

## Architecture Constraints
Raw audit JSON stays out of normal UI. Avoid leaking sensitive values unnecessarily. Stable actor/entity IDs with useful labels.

## Testing Requirements
Manual/import/company-change/contact alias/status events, ordering, provenance source/date/legal-context presence, privacy-safe display.

## Acceptance Criteria
- User can understand who changed what and when.
- Import/manual changes distinguishable.
- Future agent actor representable.

## Documentation Updates
Document visible event formatting.

## Handoff Notes
Database Explorer may expose deeper raw values only where safe.
