# Task 03 — Implement core relational schema and migrations

## Goal
Implement reviewed V1 logical data model including durable contactability, company domain, provenance/import support and lightweight contact tracking.

## Context
Use `../../docs/data-model.md`. This schema must remain simple enough for V1 yet safe for future agents.

## Coding Skill Requirement
Before editing code, load and follow `/caveman` and `/coding-guideline` from `~/ai/skills/`.

## Scope
### In Scope
- Companies, establishments, prospects, roles, categories, segments, referents.
- Emails/phones alias records.
- Contact tracking + status history.
- Contactability/do-not-contact state.
- Prospect provenance, import batches/row metadata, audit table.
- Stable IDs/FKs/indexes/uniqueness constraints.

### Out of Scope
- No rich opportunity/project CRM.
- No agent/campaign/message tables.
- No full RBAC.

## Dependencies
Tasks 01-02.

## Implementation Steps
1. Translate logical model to schema.
2. Create migrations/reset path.
3. Add indexes and invariants.
4. Seed only minimal configurable taxonomies.
5. Add repository/service interfaces.
6. Test company-change and contactability constraints at domain/service boundary.

## Files Likely Touched
DB schema/migrations, domain types, repositories, seed files, integration tests.

## Architecture Constraints
Taxonomies are data, not immutable enums. `do_not_contact` cannot be erased by new tracking/import. Internal referents are not auth users.

## Testing Requirements
Migration reset, FK/unique/index tests, one-primary email/phone rule, many categories, contactability persistence, response/appointment tracking fields.

## Acceptance Criteria
- Clean DB migrates.
- Data model matches reviewed docs.
- Permanent suppression is structurally separate from stage.
- No CRM overreach.

## Documentation Updates
Generate/update schema/ERD docs if supported.

## Handoff Notes
Company alias table is optional; add only if Task 08 dedup proves it materially useful.
