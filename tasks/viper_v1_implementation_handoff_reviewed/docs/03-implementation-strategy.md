# 03 — Implementation Strategy

## Phase 0 — Orchestration and safety
Inspect repo, confirm it is still safe to target, protect private source data from the public repository, and maintain the task plan.

## Phase 1 — Foundation
Choose/scaffold stack, implement Neon Command shell, create relational schema, secure single-user auth/actor context, then audit/provenance core.

## Phase 2 — Manageable master data
Settings taxonomies/referents and a lightweight Company editor (including establishments) before complex import/edit workflows.

## Phase 3 — Excel fidelity
Split import into deterministic parser/mapping and separate review/commit UI. Then build normalized export. Use the real workbook only as a private local compatibility check; commit synthetic fixtures only.

## Phase 4 — Technical data tooling
Build Database Explorer incrementally: read/metadata/grid first, staged writes second, read-only SQL third. Do not attempt the whole DBeaver feature set in one pass.

## Phase 5 — Daily workflow
Prospection list/counters, Prospect editor with verification UX and Save & Next, then Home dashboard and global search.

## Phase 6 — Deferred surface + history + release
Add Exploitation placeholder, focused visible history, then hardening/security/accessibility/performance/export validation.

## Scope control
V1 is a clean database and efficient contact-verification/appointment workflow, not a CRM. Future capabilities are enabled by schema/contracts rather than mocked or prebuilt screens.
