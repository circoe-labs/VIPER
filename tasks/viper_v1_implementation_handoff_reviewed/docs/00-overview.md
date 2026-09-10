# 00 — Overview

## Product mental model

VIPER is the human interface over a shared prospecting database. In this V1, prospecting research and contact operations are manual. The value is to make that manual work faster, clearer and safer while creating a database future agents can use later.

### Core V1 objects

- **Company**: documentary/business context for prospects.
- **Establishment**: address/site information linked to a company; prospects are not linked directly to establishments in V1.
- **Prospect**: the individual person to verify/contact; this is the central human object.
- **Email / Phone**: separate alias/contact-channel records, not list strings on Prospect.
- **Contact tracking / Prospection**: lightweight state from planned contact through follow-ups, reply, appointment and simple commercial outcome.
- **Taxonomies**: Role, activity categories, commercial segment.
- **Internal referent**: Circoe person who takes over a meeting; not an application user account.
- **Provenance / Audit**: origin and mutation history, ready for future human/import/agent actors.

## V1 pages

- **Home**: global database/contact overview and next actions.
- **Prospection**: daily people-oriented verification/contact workspace.
- **Exploitation**: Coming soon only.
- **Database**: DBeaver-inspired technical explorer/editor.
- **Settings**: roles, categories, segments, referents.

## Scope guardrails

Do not turn V1 into a full CRM. Devis/commande can exist as lightweight tracking states only; there is no project/opportunity dossier, quote editor, ERP, campaign builder, email client, or automated agent workflow.

Do not enforce the future campaign target (Normandie + transport/logistics) as a database constraint. The historical workbook contains broader entities; the database is a reusable source of truth, while campaign targeting belongs to future agent/business logic.

## Primary user experience

The interface must minimize effort: prefilled forms, strong but restrained visual cues for unverified/stale data, actionable counters, filtering, Save & Next, fast global search, and direct technical inspection when needed.

## Long-term compatibility

The requirements describe VIPER as the human control layer between IProspect, the shared database, and IContact. V1 does not implement those agents, but its IDs, provenance, opt-out semantics, audit actor model, and service boundaries must not block them later.
