# Slice 05 — Prospect-scoped Mission menu and Contact context action

## Goal
Add compact prospect actions: Mission dropdown/mega-menu, custom mission with microphone, and right-click/accessible Contact action.

## Context
Mission infrastructure already supports prospect targets; voice input exists in `frontend/src/missions/voice/`.

## Canonical Concepts
Mission target = current prospect; canonical mission creation API; Contact workflow/deep-link.

## Scope
### In Scope
- Mission toolbar button near prospect actions.
- Compact 2×2 menu/panel with presets:
  - Complète cette fiche
  - Réanalyse son score
  - Cherche ses relations
  - Autre
- `Autre`: text field/textarea + microphone input.
- Create a mission with current prospect as target and useful context.
- Right-click context menu with `Contacter`, plus keyboard/button equivalent.
### Out of Scope
- New mission engine.
- Automatic contact send.

## Dependencies
### Hard `depends_on`
- 00.
### Soft `requires`
- Slice 04 reassessment semantics for preset mapping. Fallback: preset emits an explicit `reassess prospect fit score` objective consumed later.
- Slice 01 header action slot. Fallback: standalone action component.
### Can Start With
Current `CreateMissionDialog`, mission APIs, `useSpeechInput`, Contact routes/workflow.
### Produces
Reusable `ProspectMissionMenu` / mission factory helper and contact-context action.
### Integration Checkpoint
Before 07, each preset must create the intended canonical mission payload against the current prospect.

## Implementation Steps
1. Create a prospect-scoped mission factory mapping preset → mission name/type/category/skills/objective/prompt while preserving server validation.
2. Build compact keyboard-navigable 2×2 menu/panel; no full-screen overlay.
3. Add custom prompt mode with microphone using existing voice hook/permissions/error behavior.
4. On creation, show success + path to mission detail; do not auto-run unless canonical current UX explicitly allows/requests one-off run semantics and PM validates it.
5. Add contextmenu handler for `Contacter` and an accessible explicit action.

## Files Likely Touched
Prospect header/editor action components, mission API/form helpers, voice hook reuse, contact navigation, CSS/tests.

## Architecture Constraints
Mission must use `prospect_id` target. Do not encode the prospect only in free-text. No duplicate speech stack.

## Automated Validation
Keyboard/mouse accessibility smoke, target-payload API check, microphone fallback behavior, targeted build/typecheck. Do not run full suite.

## Acceptance Criteria
- Mission button opens compact 2×2 choices.
- Custom mission accepts typed or dictated objective.
- Created mission is unambiguously bound to current prospect.
- Right-click Contact works and has keyboard/button parity.

## Documentation Updates
Prospect-editor and missions UI docs.

## Handoff Notes
Coordinate preset names with mission categories/skills discovered at runtime; user-facing wording remains the locked French labels above.
