# Slice 02 — External source library, internal context sources and evidence effectiveness

## Goal
Evolve current exact-URL mission sources into a reusable external source knowledge library, add typed read-only internal VIPER context sources, and preserve concrete evidence citations with successful-use counters.

## Context
Current `mission_sources` stores exact URLs and `missions_count`, while `MissionTarget` links the subject being worked. Product wants root external sources such as LinkedIn/Hunter.io, optional recurring sub-sources, descriptions, category defaults and a counter that increases only when a source actually contributed to a validated/found information item. Mission creation must also be able to link relevant VIPER database records (for example company/client/prospect cards) as supporting model context without turning those records into external source entries or conflating them with the target.

## Canonical Concepts
Mission sources, mission links, result evidence, human review, factual telemetry.

## Scope
### In Scope
- Root source entity and optional parent/sub-source hierarchy.
- Source description/use-case text.
- Typed internal context-reference association for allowlisted VIPER business records/read models.
- Runtime-safe resolver contract for serializing only permitted/current fields from those internal records.
- Category-source default associations for reusable external sources; mission-specific internal record links remain explicit references unless a safe reusable template contract already exists.
- Mission-source associations compatible with category inheritance.
- Concrete evidence citation records carrying actual URL/check/observation data and linking to submitted result/item where practical.
- Successful-contribution counter semantics and idempotent increment rules.
- Multiple sources supporting one information item.
- Migration/compatibility for existing `mission_sources` and links.
- Source CRUD/query APIs for admin and mission authoring, including search/link/unlink of allowed internal records as context sources.

### Out of Scope
- Admin visual table (Slice 05).
- Generic web crawler or automatic site taxonomy classification beyond bounded normalization rules.

## Dependencies
### Hard `depends_on`
- Slice 01: category/source default FK/association shape and mission inheritance representation must be established; both touch mission persistence/migrations.

### Soft `requires`
- Slice 04 result/evidence envelope: need exact output evidence shape; fallback is an adapter storing result/item IDs and URL metadata without assuming final JSON field names. Mandatory before Slice 07 runtime integration.

### Can Start With
Existing `MissionSource`, `MissionSourceLink`, result tables and review/evidence concepts.

### Produces
Source hierarchy/evidence schema, migration, services/APIs and contribution-count contract.

### Integration Checkpoint
Before Slice 05 live UI wiring and Slice 07 result-submission counting integration.

## Implementation Steps
1. Define root/sub-source identity and URL/domain normalization rules.
2. Define internal-context reference kinds/allowlist and keep them distinct from `MissionTarget`; do not expose arbitrary table/model selection or SQL.
3. Preserve concrete cited URLs separately from reusable source identity.
4. Migrate existing saved links without dropping mission associations.
5. Implement category/external-source defaults plus per-mission external-source and internal-context associations.
6. Implement a bounded internal-context resolver/read contract for claim payload use.
7. Define successful contribution as a result item/fact actually supported by an external source, not page visit or attachment; internal context is provenance/context and must not accidentally increment external-source effectiveness.
8. Make counting idempotent so resubmission/review rebuild cannot inflate counts.
9. Support multiple evidence citations for one item and ensure each qualifying external source increments once per contribution event.
10. Expose list/filter endpoints including successful-use count/hierarchy and internal-record context search/linking.

## Files Likely Touched
Mission/source models, migrations, services/routes, result evidence bridge, docs.

## Architecture Constraints
- Telemetry `SOURCE_OPENED` does not by itself increment effectiveness.
- Do not store chain-of-thought.
- Keep URLs used as evidence even when library display rolls them up to a root/sub-source.
- Internal context is read-only model context, not evidence by default and never a shortcut to direct database mutation.
- Target and context-source semantics must remain distinct in API/types.
- `/caveman` and `/coding-guideline` required.

## Automated Validation
Migration/read-write smoke, idempotency check and bounded evidence-count scenario. Do not launch the full unit test suite at this Slice boundary.

## Acceptance Criteria
- LinkedIn profile/job URLs can roll up under LinkedIn / LinkedIn > Jobs without becoming top-level library spam.
- A visit alone does not increment the successful-use counter.
- A fact supported by three distinct sources credits all three once.
- Existing mission source links survive migration/compatibility.
- A mission can link an allowed internal record as supporting context without making it the task target; claim-time resolution exposes only the permitted read model.

## Documentation Updates
Add canonical source/evidence/effectiveness contract.

## Handoff Notes
Coordinate with Slice 04 on evidence envelope through the soft requirement; do not invent a second result format.
