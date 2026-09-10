# VIPER V1 — Implementation Handoff (reviewed)

This bundle is the **critically reviewed** implementation handoff for VIPER V1. It reconciles the full grill session with the VIPER portions of the functional requirements, the legacy Excel workbook, the selected **Neon Command** art direction, and the accepted VIPER logo variants.

## V1 goal

VIPER V1 is first a **clean, maintainable prospect database with a high-quality human interface**. The core loop is:

**Excel/CSV import → controlled review → normalized database → manual verification/editing → lightweight contact tracking → Excel export**.

The V1 also includes a global Home dashboard, a people-oriented Prospection workspace, a technical Database Explorer, Settings for taxonomies/referents, and an Exploitation placeholder.

## Explicit non-goals

Do not implement IProspect, IContact/iExploitation automation, automatic email sending, Calendly synchronization, agent scoring, a rich opportunity CRM, project delivery management, or fake future-agent data.

The long-term contract still matters: stable IDs, provenance, audit actors, durable opt-out state, and clean service boundaries must allow future agents to read/write the shared database without a schema rewrite.

## Important corrections from the first handoff

The review found and fixed material gaps: secure single-user authentication was missing; audit was scheduled too late; contact provenance/legal-context fields were incomplete; permanent do-not-contact state was incorrectly represented only as a pipeline status; company email domain was missing; response/no-response tracking needed by Home was under-modeled; there was no dedicated company editor; Database Explorer and Excel import tasks were too large; legacy Excel anomalies such as `retraité`, inconsistent civilities and empty historical status columns were not captured; and the Neon Command moodboard needed a warning not to copy its cyber-security content or snake logo.

See `docs/05-critical-review.md` for the complete audit.

## Public-repository warning

The target repository `circoe-labs/VIPER` was public at review time. `sources/BASE_CLIENT.xlsx` contains real contact data and is included **only as a private local compatibility reference**. It must never be committed, uploaded to CI artifacts, printed in logs, or copied into public fixtures. Use synthetic fixtures in the repository.

## Read first

1. `tasks/TODO.md`
2. `docs/00-overview.md`
3. `docs/01-decision-log.md`
4. `docs/05-critical-review.md`
5. `docs/data-model.md`
6. `docs/excel-mapping.md`
7. `docs/interface-spec.md`
8. `docs/design-system.md`
9. `docs/security-and-provenance.md`
10. `grill-session.md`

Design maturity: brand direction and logo family are selected; detailed product screens are functionally specified but not pixel-perfect final renders. Build from the selected DA without inventing unrelated visual language.
