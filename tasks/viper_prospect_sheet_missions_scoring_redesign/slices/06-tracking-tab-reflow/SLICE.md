# Slice 06 — Suivi tab reflow

## Goal
Apply the same hierarchy/alignment discipline to the existing Suivi tab without changing its business semantics.

## Context
Current Suivi contains tracking/contact state, notes, sequence, alerts/provenance/history depending on the prospect state.

## Canonical Concepts
TrackingSection, ProspectNotes, SequenceSection, Alerts/Provenance/History.

## Scope
### In Scope
- Reorganize Suivi into a coherent scan-first layout.
- Surface current status / next action / key dates first.
- Align notes, sequence/contact history, provenance/history into balanced cards/sections.
- Preserve existing edit/actions and state transitions.
### Out of Scope
- New commercial pipeline semantics.
- New contact automation.

## Dependencies
### Hard `depends_on`
- 00.
### Soft `requires`
- Slice 01 layout tokens/primitives. Fallback: consume current design tokens and isolate Suivi child components; reconcile before 07.
### Can Start With
Current Suivi components and tests.
### Produces
Reflowed Suivi layout with stable component boundaries.
### Integration Checkpoint
Merge visual primitives with Slice 01 before 07.

## Implementation Steps
1. Inventory current Suivi blocks and priority order.
2. Put status/next-action/date summary at top.
3. Group notes and contact/sequence activity into aligned sections.
4. Keep provenance/history available but visually secondary.
5. Verify long histories, empty states and narrow widths.

## Files Likely Touched
Suivi child components/CSS; minimize direct edits to `ProspectEditor.tsx` if Slice 01 owns it.

## Architecture Constraints
No business-state rewrite. No automatic follow-up/send behavior.

## Automated Validation
Targeted component/runtime checks and type/build checks. Do not launch full unit suite.

## Acceptance Criteria
- Suivi reads as intentionally organized, not a stack of unrelated panels.
- Existing actions/states remain reachable and unchanged semantically.
- Responsive and keyboard access remain correct.

## Documentation Updates
Prospect-editor UX docs.

## Handoff Notes
Prefer child-component composition to reduce merge conflict with Slice 01.
