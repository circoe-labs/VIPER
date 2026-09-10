# Task 15 — Implement reusable Prospect create/edit drawer and verification UX

## Goal
Build the central low-effort form for adding/verifying/updating prospects, contact aliases, contactability and lightweight contact tracking.

## Context
The user emphasized prefilled data, field/section verification feedback and minimum manual effort. Company editing is delegated to Task 07 editor.

## Coding Skill Requirement
Before editing code, load and follow `/caveman` and `/coding-guideline` from `~/ai/skills/`.

## Scope
### In Scope
- Same add/edit drawer.
- Identity.
- Company selector + open/create company flow.
- Role selector + inline create; exact job title.
- Activity status + employment verification date.
- Email/phone alias repeaters with primary, verification, origin/source.
- Durable do-not-contact control.
- Contact tracking: planned date, stage, response, appointment, referent.
- Yellow warning on imported dynamic/unverified values.
- Dirty state, validation, Save/Cancel/Delete-safe.
- Save & Next preserving current queue.
- Provenance/recent history access.
- Company-change re-verification behavior.

### Out of Scope
- No external enrichment.
- No email generation/sending.
- No full CRM company/project editor inside this drawer.

## Dependencies
Tasks 05-07 and 14.

## Implementation Steps
1. Define form model/validation.
2. Build reusable drawer.
3. Add taxonomy/company selectors.
4. Add verification visuals and contact aliases.
5. Add contactability/tracking controls.
6. Implement transactional save + company-change behavior.
7. Add Save & Next.
8. Audit/provenance integration.
9. Tests.

## Files Likely Touched
Prospect form components, services, validation, alias editors, tests.

## Architecture Constraints
No company field duplication. Employment and contact-channel verification stay separate. Permanent suppression cannot be casually cleared. Save is atomic.

## Testing Requirements
Create/edit, role inline create, alias primary uniqueness, employment verification, company change, blocked status, tracking/response/appointment, Save & Next, dirty cancel, audit.

## Acceptance Criteria
- Same form handles add/edit.
- Existing values prefilled.
- User can see what needs verification.
- Multiple contacts work.
- Save & Next is reliable.
- All mutations traceable.

## Documentation Updates
Update field semantics/help copy docs.

## Handoff Notes
Global visual reference: `../../visuals/neon-command-brand-direction.png`.
