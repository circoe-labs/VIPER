# Prospection feedback decisions — 10 September 2026

This note records product decisions made during direct use of the first VIPER Prospection implementation. It supplements the reviewed handoff where the latest feedback is more specific.

## Verification
- Employment verification date is system-managed, not a manually typed form field.
- When a human edits the employment context (company, role, exact title, activity status), saving constitutes a verification event and VIPER timestamps it.
- An unchanged record can be explicitly marked verified now; VIPER supplies the timestamp.
- Excel may contain an explicit `Vérification` column. `Vérifié` without a date means verified at import time; `À vérifier` remains unverified.
- Backward compatibility: legacy `v` in the polluted Referent column means verified only when no explicit verification column exists. `xxx` and `?` mean not verified.
- Employment verification and email/phone verification remain separate scopes.

## Planned contact
- Legacy `Sxx` is a contact week, never a referent.
- It is stored as a real planned-contact date on Monday.
- The year is chosen by nearest ISO-week continuity around import time, so imports around New Year choose the closest preceding/current/following year rather than blindly assuming the calendar year.

## Contact tracking
- User-facing stages are French: À contacter, Contacté, Relance 1, Relance 2, Réponse reçue, Rendez-vous obtenu, Devis envoyé, Devis relancé, Commande passée, Non intéressé.
- Internal identifiers remain stable snake_case implementation values only.
- Stage-change timestamps are automatic through tracking history.
- Response time is automatic when entering Réponse reçue.
- Appointment time remains manually entered and is only shown once the stage makes it relevant.
- Internal referent is mainly shown once an appointment exists or later.

## Prospect editor UX
- Separate database maintenance from follow-up: tabs for `Identité & emploi`, `Coordonnées`, `Suivi de contact`, `Provenance`.
- Do not show every tracking date at once; show fields relevant to the selected stage.
- Provenance from Excel remains visible.

## Prospection list UX
The three highest-priority scan signals are:
1. identity + role/title + company;
2. verification quality;
3. current contact stage.

Verification indicator:
- neutral/white = never verified;
- orange = employment verified but contact data incomplete/unverified;
- green = employment and primary email verified.

Search is accompanied by quick filter buttons and a company filter. The list is horizontally scrollable when secondary columns exceed the available width.
