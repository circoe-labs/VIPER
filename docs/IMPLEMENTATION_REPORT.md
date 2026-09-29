# VIPER V1 — Implementation report (GPT)

## Scope delivered
The branch implements the manual, database-first VIPER V1 described by the reviewed handoff: authenticated human interface, normalized shared-data foundation, controlled Excel adapter, manual verification/contact tracking, Home, Prospection, Database, Settings, global search and an Exploitation placeholder.

## Source-of-truth guardrails
- No IProspect or IContact runtime behavior is mocked.
- No automatic email sending or Calendly synchronization exists.
- Durable `contactability_status=do_not_contact` cannot be cleared by the standard prospect update endpoint and import never rewrites it.
- Imported rows carry source provenance; opaque fields are retained in `import_row_metadata.legacy_metadata`.
- Real source workbook data is not committed and is explicitly ignored/blocked by CI.
- Normandie / transport-logistique targeting is not enforced as a database constraint.

## Verification against handoff
The implementation was checked against `tasks/TODO.md`, `docs/data-model.md`, `docs/interface-spec.md`, `docs/excel-mapping.md`, `docs/security-and-provenance.md`, `docs/04-testing-and-quality.md`, `docs/05-critical-review.md` and `grill-session.md`.

### Feedback reconciliation — 10 September 2026
A second review was performed after hands-on use of the Prospection workflow. The following corrections are now part of the implemented contract:

- Verification is a data-quality concept, separate from commercial tracking. The UI no longer asks the operator to type a verification date.
- Editing employment context or explicitly marking it verified timestamps `employment_verified_at` automatically.
- Email/phone verification status is editable but its verification timestamp is generated automatically when the status becomes verified.
- Changing company invalidates company-dependent email/phone verification while recording the newly edited employment context as verified by the human action.
- Contact-stage changes are written to `contact_tracking_status_history`; entering `Réponse reçue` automatically records the response time. Appointment date remains a manual field and only appears in the relevant stages.
- User-facing tracking labels are French: À contacter, Contacté, Relance 1, Relance 2, Réponse reçue, Rendez-vous obtenu, Devis envoyé, Devis relancé, Commande passée, Non intéressé.
- The editor is split into Identity & employment, Coordinates, Contact tracking and Provenance tabs so database maintenance is visually separated from exploitation/follow-up.
- The Prospection list keeps identity, verification quality and contact stage as the primary scan fields, uses neutral/orange/green verification indicators, adds quick filters beside search, an enterprise filter and horizontal scrolling.

### Excel compatibility correction
The prior parser treated every imported employment verification as unknown and treated `S37/S39` as unresolved. The latest product decision supersedes that behavior:

- explicit Excel columns `Vérification` / `Verification` are supported;
- when a verified source row contains no verification date, the import timestamp becomes the verification date;
- the current legacy workbook is backward-compatible: `v` in the polluted historical Referent column is treated as verification, while `xxx`, `?`, email-like values and notes are not imported as referents;
- `Sxx` is converted to the Monday of the nearest ISO week relative to import time, making year-boundary continuity deterministic;
- re-import can update existing records and now maps referent, phone/mobile, address, category and company project/reference fields instead of dropping them.

A private, aggregate-only compatibility check of the retained workbook showed the new rules would recover the existing verified markers and planned S37/S39 rows without logging contact data.

### Satisfied acceptance areas
Authentication, normalized IDs/FKs, prospect/company split, aliases, verification dates/statuses, opposition durability, audit/provenance, controlled Excel preview/commit, normalized export, human Prospection workspace, Home real-data metrics, read-only SQL enforcement, taxonomies/referents, global search and honest Exploitation placeholder.

### Known partial area
Task 12's full DBeaver-class generic staged mutation UX (column pin/reorder/resize, generic add/delete with rich FK diagnostics, context menu operations) is not fully implemented. Domain editors are the safe mutation path in this V1 branch; the status is intentionally `[~]` rather than falsely complete.

## Security notes
Single-user pilot auth uses opaque in-memory session tokens in HTTP-only SameSite=strict cookies. Production must provide strong credentials and HTTPS. No plaintext mailbox password is stored because mail integration is out of scope.

## Testing
The patch was syntax/type checked locally with strict enough interface stubs to catch TS/JSX errors. The import logic was also reconciled against the private legacy workbook using aggregate-only inspection; no row-level PII was printed or committed. Unit tests were updated for explicit verification and ISO-week conversion. GitHub CI remains authoritative for dependency-backed typecheck, Vitest and Vite build.
