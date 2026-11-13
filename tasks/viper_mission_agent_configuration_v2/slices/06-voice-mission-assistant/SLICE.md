# Slice 06 — Voice/conversational mission authoring

## Goal
Add an optional voice-first conversational mode that edits the normal mission draft, asks concise clarifying questions when needed and finalizes through ordinary mission validation.

## Context
Product reference: immersive black/blurred screen, close control top-left, user transcript in blue lower area, assistant response in large white type around upper-middle/first-third, live voice/wave orb bottom-right. Draft-first by default; explicit user “go/create” command can skip further questions.

## Canonical Concepts
Mission draft, category/skills/sources defaults, normal mission create/update validation.

## Scope
### In Scope
- Microphone entry point in mission creation.
- Full-screen/overlay voice surface matching described hierarchy.
- Local Whisper-compatible STT preferred where deployment supports it; explicit fallback strategy when unavailable.
- Live partial/final transcription and visual audio feedback.
- Conversational assistant with short responses/questions.
- Load the dedicated editable mission-creator behavior/task prompt from Settings before conversation turns; category prompts remain worker instructions, not this assistant's system behavior.
- Structured draft-manipulation tools/functions: set name, category, mission prompt, skills, external sources, internal VIPER context references, objective, recurrence and other mission options; read current draft.
- “Create/finalize” intent that calls the same validation/create path as the form.
- Close/cancel without unintended mission creation.
- Permissions/error/fallback UX for microphone/STT/model failure.

### Out of Scope
- New independent mission creation backend.
- Autonomous mission creation without user intent/validation.
- General-purpose voice assistant outside mission creation.

## Dependencies
### Hard `depends_on`
- Slice 05: owns the current mission creation surface/category/default UI; this Slice must extend that settled seam rather than competing on the same hot file.

### Soft `requires`
- Slice 04 objective/output-contract model: need objective, recurrence/completion semantics and output options (`allow_multiple`); fallback is draft field support matching published API contract. Mandatory before Slice 08.
- Slice 01 mission-creator prompt read contract: fallback is built-in default prompt only; configurable override is mandatory before final integration.

### Can Start With
Current CreateMissionDialog after Slice 05, browser audio APIs and existing backend/model integration patterns.

### Produces
Voice overlay/components, STT adapter, conversational draft tool contract and mission-draft integration.

### Integration Checkpoint
Before final E2E/visual validation in Slice 08.

## Implementation Steps
1. Apply `/impeccable`, `/caveman`, `/coding-guideline` and frontend routing rule.
2. Factor mission draft state so keyboard/form and voice share one source of truth.
3. Add microphone entry and permission handling.
4. Implement STT adapter with local-first option and deployable fallback/disabled state.
5. Load the Settings-managed mission-creator prompt (or built-in default) and implement concise assistant turn behavior from that contract.
6. Implement structured draft actions for category/instructions/skills, external sources, internal context records, objective and recurrence.
7. Render transcription/assistant/wave layout as specified.
8. Implement create/finalize bypass intent while still using ordinary form/domain validation.
9. Ensure cancel/close never creates a mission.

## Files Likely Touched
Mission creation components/state, new voice module/styles, API/model adapter, possibly backend assistant endpoint if required.

## Architecture Constraints
- No direct database writes from conversational model.
- Model manipulates draft through bounded tools/functions.
- Internal database context is selectable only through allowlisted search/reference tools; never expose arbitrary SQL/table access.
- Creator behavior prompt is centrally configurable in Settings and distinct from category/worker prompts.
- Keep responses short; ask only questions that materially improve the mission.
- Frontend Slice requires `/impeccable` plus `/caveman` and `/coding-guideline`.

## Automated Validation
Type/build/static checks, microphone-permission fallback smoke, draft-tool trace and bounded browser flow. Do not launch the full unit test suite at this Slice boundary.

## Acceptance Criteria
- Voice input updates the same mission draft as manual input.
- UI shows live feedback/transcription and readable assistant question/response.
- Assistant can ask a clarification and apply the answer.
- Assistant can attach a relevant external source or internal VIPER context record and can set one-off/recurring objective fields.
- Changing the configured mission-creator prompt affects subsequent creator conversations without editing category worker prompts.
- Clear “create/go” command finalizes through normal validation.
- Closing/canceling is safe and leaves no mission.

## Documentation Updates
Document STT/model dependency and graceful-degradation path.

## Handoff Notes
Provide a real trace from speech/transcript -> draft actions -> validated mission create request.
