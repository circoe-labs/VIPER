# Data Model — V1 logical contract (reviewed)

> Physical names are indicative. Preserve semantics even if ORM naming differs.

## `companies`
- `id` stable UUID/ID PK
- `display_name` required
- `legal_name` nullable
- `siren` nullable, unique when present
- `website_url` nullable
- `email_domain` nullable, normalized/indexed
- `size_label` nullable (do not invent taxonomy yet)
- `commercial_segment_id` nullable
- legacy/company metadata: `project_done_with_circoe`, `project_type`, `circoe_references`, `client_approach` nullable
- timestamps

Relations: many-to-many activity categories; one-to-many establishments; one-to-many prospects.

## `establishments`
- `id`, `company_id`
- `name` nullable
- `siret` nullable, unique when present
- address fields: line1/line2/postal_code/city/country
- `kind` nullable (`siège`, `agence`, `entrepôt`, etc.)
- `is_primary`
- timestamps

Prospect is not directly linked to establishment in V1.

## `prospects`
- `id`
- `company_id` normally required after import resolution
- `civility` nullable/normalized
- `first_name`, `last_name`
- `role_id` nullable
- `exact_job_title` nullable
- `activity_status`: `active | inactive | unknown`
- `employment_verified_at` nullable; null = never verified/current employment context not verified
- `contactability_status`: `contactable | do_not_contact`
- `do_not_contact_at` nullable
- `do_not_contact_reason` nullable
- timestamps

Activity status and contactability are independent: an active employee can still be permanently blocked from prospecting.

## `roles`
Administrable taxonomy: id, label, slug, active, timestamps. Seed values are suggestions, not immutable product truth.

## `emails`
- `id`, `prospect_id`
- `address` normalized
- `is_primary`
- `is_active`
- `verification_status`: `unverified | verified | invalid | unknown`
- `origin_type`: `imported | manual | published | inferred | other`
- `last_verified_at` nullable
- `source_reference` nullable
- timestamps

Max one active primary email per prospect. Keep former addresses; never silently delete on company change.

## `phones`
Same pattern as emails:
- `id`, `prospect_id`, `number`, `type` (`mobile | landline | other`), `is_primary`, `is_active`
- verification status, origin type, last verified date, source reference, timestamps

## `commercial_segments`
Administrable taxonomy. A company has at most one primary segment.

## `activity_categories`
Administrable taxonomy with join table `company_activity_categories` for company many-to-many.

## `internal_referents`
- `id`, first_name, last_name, email nullable, active, timestamps

These are Circoe meeting/dossier referents, not application login accounts.

## `contact_tracking` (`prospections` internally if preferred)
- `id`
- `prospect_id`
- `planned_contact_at` nullable
- `status`
- `referent_id` nullable
- `response_received_at` nullable
- `appointment_at` nullable
- timestamps

Recommended current status base:
`to_contact`, `contacted`, `follow_up_1`, `follow_up_2`, `response_received`, `appointment_obtained`, `quote_sent`, `quote_follow_up`, `won`, `not_interested`.

`do_not_contact` is **not only a stage**; use the durable prospect contactability restriction. UI may present it alongside outcomes.

V1 default: one current contact-tracking row per prospect + history. Multiple independent cycles remain deferred.

## `contact_tracking_status_history`
- `id`, `contact_tracking_id`
- `from_status`, `to_status`
- `changed_at`
- `actor_id/type` or audit link

Allows derivation of first contact/follow-up/status dates without duplicating five legacy booleans.

## `prospect_sources`
Minimal provenance required by the functional spec:
- `id`, `prospect_id`
- `source_type`: `excel_import | manual | future_agent | other`
- `source_reference` nullable (file/sheet/row or URL/ref)
- `collected_at`
- `legal_basis_or_collection_context` nullable
- `created_by_actor` nullable/reference
- notes nullable

A prospect may have multiple provenance records over time.

## `import_batches`
- id, filename, sheet(s), imported_at, actor, row counts, status
- optional file fingerprint; never store sensitive raw workbook bytes in DB unless explicitly chosen

## `import_row_metadata`
- batch_id, source_sheet, source_row_number, linked prospect/company IDs
- `legacy_metadata` JSON/object for unknown or intentionally opaque legacy columns

This supports no-silent-loss without polluting first-class tables.

## `audit_log`
Append-only application audit for meaningful mutations:
- actor type/id/display snapshot (`human`, `import`, future `agent`, `system`)
- entity type/id
- action
- changed fields/before-after payload constrained to useful data
- source/context
- timestamp

## Verification UX contract

Avoid a generic field-metadata system unless implementation proves necessary. Use explicit verification scopes:
- `employment_verified_at` covers current company/role/job-title/activity context;
- each Email/Phone has its own verification status/date;
- stable identity fields (e.g. first name) carry provenance/audit but are not individually re-verified by default;
- imported dynamic values with no corresponding verification date render as warning/unverified.

This is sufficient for the requested yellow-field/section feedback while keeping the schema understandable.
