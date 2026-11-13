# Slice 05 — Admin UI, grouped navigation and category-aware mission creation

## Goal
Add admin-facing management for categories, skills, sources and the mission-creator prompt; reorganize the sidebar into sections; and make mission creation category-aware with external/internal context sources plus objective/recurrence controls.

## Context
Current mission creation already has Category, Skills and Sources panels, but category is fixed, Skills mainly selects an agent, and sources are exact links. Sidebar is flat. Mission card colors currently hash mission IDs.

## Canonical Concepts
Admin configuration, mission draft, inherited defaults/overrides, source hierarchy.

## Scope
### In Scope
- Sidebar grouping: main; configuration; administration.
- Administration area for category catalog, instruction skills and source library.
- Category one-page editor: name, icon, color, description, general prompt, default skills, default sources.
- Category create/edit/delete UX with safe deletion states.
- Skill create/edit/reuse UI.
- Source tree/table with root/sub-source expansion, description and successful-use count.
- Mission source picker distinguishes external research sources from internal VIPER context records and supports searching/linking allowed database records.
- Settings editor for the dedicated mission-creator behavior/task prompt, following the existing PromptSection UX conventions and reset-to-default behavior.
- Mission creation category selector with icon/color and application of defaults.
- Mission creation controls for explicit objective and one-off vs recurring execution, reusing existing recurrence fields/controls and making per-period objective semantics understandable.
- Clear inherited-vs-overridden state and reset-to-default action where useful.
- Mission list/detail visual accent from category color/icon, not mission ID hash.
- Admin placement/route guards consistent with existing role model; future granular RBAC out of scope.

### Out of Scope
- Voice overlay (Slice 06).
- Backend persistence APIs (01/02).

## Dependencies
### Hard `depends_on`
- Slice 01: live category/skill API and inheritance contract.
- Slice 02: live source hierarchy/effectiveness API.

### Soft `requires`
- Slice 04: need final objective/completion field/API shape; fallback to fixture/draft adapter over current recurrence controls. Mandatory before live mission-create integration/06.
- Existing mission UI redesign task: need current shipped surface/components. Fallback is to audit main and adapt to current components, never reintroduce old layout. Mandatory before merge.

### Can Start With
Published API contracts/fixtures from 01/02 and current frontend components.

### Produces
Admin configuration surfaces, grouped navigation and category-aware mission UI.

### Integration Checkpoint
Before Slice 06 edits CreateMissionDialog and before Slice 08 visual/E2E validation.

## Implementation Steps
1. Apply `/impeccable`, `/caveman`, `/coding-guideline` and host frontend routing.
2. Group navigation without removing existing destinations.
3. Build admin route/surfaces against live APIs.
4. Build category selector/cards with category icon/color.
5. Replace `accentForMission(card.id)` usage with category-owned visual identity while keeping status semantics separate.
6. Surface inherited/overridden defaults without making the form noisy.
7. Keep external source selection hierarchical and display successful-use count, not fake relevance color scores.
8. Add a distinct internal-context source selector/search over allowed VIPER records, clearly separate from targets.
9. Add mission objective controls alongside the existing one-off/recurring controls and wire them to Slice 04's API.
10. Add mission-creator prompt editing in Settings with current/default source indicator and reset behavior.

## Files Likely Touched
`frontend/src/shell/navigation.ts`, sidebar/routes, missions create/list/detail components, new admin modules, API hooks/styles.

## Architecture Constraints
- UI must not infer business state from color alone.
- Skills are instruction blocks only.
- Source count means successful contributions, not missions attached.
- Frontend Slice requires `/impeccable` plus `/caveman` and `/coding-guideline`.

## Automated Validation
Type/build/static checks and bounded browser/runtime smoke for navigation/admin/category selection. Do not launch the full unit test suite at this Slice boundary.

## Acceptance Criteria
- Admin can manage categories/skills/external sources and edit the mission-creator prompt.
- Mission author can link relevant internal VIPER records as supporting context without changing the target.
- Mission category chooser shows icon/color and applies defaults.
- Existing missions render stable category color/icon.
- Sidebar sections match product grouping without losing routes.
- External source UI can expand root to sub-sources and shows successful-use count.
- Mission authoring exposes objective + one-off/recurring semantics using the existing recurrence model.

## Documentation Updates
Update frontend/admin usage docs if present.

## Handoff Notes
Own `CreateMissionDialog` category/default changes; Slice 06 waits to avoid hot-file conflict.
