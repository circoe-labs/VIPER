# Slice 01 — Mission categories and instruction-skill foundation

## Goal
Replace the fixed product-level mission category taxonomy with an admin-extensible persisted category catalog seeded from current values, and add reusable instruction skills plus inheritance/override semantics.

## Context
`MissionType` is currently a fixed enum used both by UI labeling and runtime routing. Product categories must become editable without breaking technical task generation. Mission card accent is currently hashed from mission ID.

## Canonical Concepts
Mission, MissionType, mission create/update, audit, organization ownership.

## Scope
### In Scope
- Persist configurable mission categories with name, description, icon, color, general prompt and stable technical execution mapping where required.
- Add a dedicated persisted mission-creator behavior/task prompt setting with built-in default + human override, reusing the existing Settings/app-setting/integration pattern rather than embedding prompt text in the frontend.
- Seed current categories: prospection, signals, enrichment, verification, other.
- Persist reusable instruction skills and category-skill associations.
- Add mission category reference and explicit inherited-vs-overridden state for category-derived fields.
- Define category CRUD/admin APIs and skill CRUD/association APIs.
- Backfill existing missions safely.
- Preserve internal technical routing semantics.
- Update canonical docs.

### Out of Scope
- Source library persistence (Slice 02).
- Admin UI (Slice 05).
- Voice UI (Slice 06).
- Tool/capability grants through skills.

## Dependencies
### Hard `depends_on`
- Slice 00 must be `READY`.

### Soft `requires`
None.

### Can Start With
Existing `MissionType` enum, mission models/services/routes, explicit product contract in docs.

### Produces
Persisted category/skill schema, migration, service/API contract, seeded data and mission inheritance metadata.

### Integration Checkpoint
Before Slice 02 migration and before Slice 05 live admin wiring.

## Implementation Steps
1. Design category persistence without making mutable business taxonomy a new hard enum.
2. Preserve a technical execution discriminator if runtime routing still needs it.
3. Add skill persistence as instruction content plus metadata/version timestamps as warranted.
4. Add category-skill links and category default prompt/icon/color semantics.
5. Add/read/update the dedicated mission-creator prompt setting/API, distinct from category prompts; preserve the repository's existing editable-prompt conventions.
6. Publish the prompt read contract to Slices 05/06.
7. Implement field-level mission inheritance/override tracking; do not infer override solely by comparing current text with category text.
8. Seed/backfill existing values with reversible migration strategy.
9. Expose read/write APIs with organization/admin authorization consistent with current app patterns.
10. Update mission card read model to expose category visual identity, but leave UI rendering to Slice 05.

## Files Likely Touched
`backend/app/models/missions.py`, enums only if compatibility is needed, migrations, mission services/routes/schemas, Settings/app-setting or integrations prompt configuration backend, audit/docs.

## Architecture Constraints
- Skills are instruction text only.
- Existing missions remain runnable during/after migration.
- Do not delete/rename technical enum behavior until all routing consumers are migrated.
- `/caveman` and `/coding-guideline` required.

## Automated Validation
Migration/static/type/API smoke checks and focused data-backfill inspection. Do not launch the full unit test suite at this Slice boundary.

## Acceptance Criteria
- Existing missions map to seeded categories.
- Admin APIs can create/edit/delete categories subject to safe reference rules.
- Skills can be reused across categories.
- Category defaults propagate only to mission fields still marked inherited.
- Mission explicit overrides remain unchanged after later category edits.
- Mission-creator behavior prompt is readable with a built-in default, can be human-overridden/reset through the existing settings pattern, and remains distinct from category worker prompts.

## Documentation Updates
Update `doc/architecture/missions.md` or its canonical successor with category/skill/inheritance contract.

## Handoff Notes
Publish the exact category read/write contract for Slices 02 and 05.
