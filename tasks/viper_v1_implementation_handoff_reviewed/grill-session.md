# Grill session — expanded faithful reconstruction

> This is a reconstructed grill session based on the full available conversation. It is intentionally more detailed than the first handoff. It preserves corrections and changes of direction. Unresolved points are labelled explicitly; no missing decision is silently invented.

## A. Starting context

The project documentation described three future pieces sharing data: IProspect collects/enriches, VIPER is the human validation/control interface, and IContact exploits data for commercial actions. The user explicitly asked the grill to focus on VIPER's human interface and database rather than imitate an earlier visual interface.

The first design question was whether Home should be an action inbox or global dashboard. The initial recommendation favored an action inbox. The user corrected this: for a vendor/commercial user, **global visibility of activity is more important on entry**. Home should therefore lead with overall state, with actions beneath/alongside it.

## B. V1 scope was sharply reduced

The user then reset scope: current prospecting is manual. Do not implement IProspect or IContact/iExploitation behavior now. VIPER V1 should mainly make the database clean, easy to update manually, and compatible with Excel.

Locked core loop:
**Excel/CSV upload → controlled database feed → manual forms/updates → download a refreshed Excel representation**.

The user explicitly accepted a clean internal model rather than one SQL table mirroring the spreadsheet. Excel is an import/export interface; normalization is internal and invisible to the operator.

## C. Legacy Excel walkthrough and semantic cleanup

The user walked through spreadsheet fields and clarified that the file is historical and semantically messy.

### Referent
`Référent` is supposed to mean the internal Circoe person who will take care of the client/meeting. Historical values such as `xxx`, `?`, week markers or miscellaneous notes do not belong there. Export must not repeat that mistake.

Future behavior: once an appointment exists and the booking/referent is known, Referent can be populated. In V1 it is manually manageable and may be blank.

### Historical verification markers
The conversation clarified that old marker values were attempts to express whether a person still had the same role/company or whether the operator could find them. The user rejected a combined verification enum like `À vérifier / Vérifié en poste / Vérifié plus en poste / Introuvable`.

Instead, two separate concepts were chosen:
- **Activity status**: `Active`, `Inactive`, `Unknown`.
- **Verification date**: nullable; blank means nobody has verified this person/current employment context yet.

A person can be `Unknown` with a recent verification date: somebody searched recently but could not conclude.

### Planned contact
`S37/S39` means a planned contact week, not Referent. The user accepted replacing week-only storage with a real planned-contact date and deriving week display.

### Company
Company should be a dedicated table with richer context for future email building: business classification, location/site information, website/domain and other context.

### Tracking columns
The old separate fields `Rendez-vous obtenu`, `Devis envoyé`, `Suivi`, `Relance 1`, `Relance 2` should not stay as five simultaneous booleans. They should collapse into a simple current tracking state plus history/dates.

### Other legacy fields
Project already done, type of project, Circoe references and client approach are company-level context/metadata. Ambiguous trailing fields should be preserved as metadata rather than discarded.

## D. Contact data normalization

The user accepted a separate Email table rather than a list-string on Prospect. One prospect can have several email aliases; one is primary. Email verification/source information belongs to each email record.

The same design was explicitly accepted for phone numbers: separate records, type, primary flag and verification/source metadata.

This is especially important when a person changes company: old company-dependent contact details should not simply be deleted.

## E. Company change behavior

The user did not need a visible CV/employment history. What matters is an alert when the company changes because the professional email may also change.

Therefore the model should keep the current company directly, retain old values in audit/history, and trigger a visible re-verification need for employment/company-dependent coordinates when company changes.

## F. Company / establishment

The user accepted separating Company and Establishment/Site so a company can have headquarters/agencies/warehouses and SIRET-address data.

The user **rejected linking Prospect directly to an Establishment in V1**. Prospect links to Company only; Establishments remain company context.

SIREN for Company and SIRET for Establishment were explicitly accepted, optional from V1.

## G. Role taxonomy

The user disliked the bare label `Fonction` and chose **Rôle** as the user-facing normalized classification.

They explicitly preferred a taxonomy rather than free text because filters will be cleaner. They also wanted inline extensibility: when the operator encounters a new role in a form, they can add it so it becomes available for future prospects.

The recommendation to keep an additional `intitulé exact` field was accepted: e.g. a specific real job title can map to a normalized Role without losing source wording.

Import behavior for unknown titles was accepted: propose a normalized existing role, never silently create a new taxonomy value; user can map/create/leave unclassified.

## H. Company classifications

The user confirmed commercial segment and activity category are two different dimensions.

Accepted:
- one primary commercial segment per company;
- multiple activity categories per company;
- both administrable/extensible like roles.

## I. Lightweight contact tracking, not CRM

A status chain was accepted as a simple base: contact planning/contacted/follow-ups/appointment/quote/follow-up/won plus negative exits. Later the user strongly recentered the product: do not create a rich commercial dossier or project-tracking CRM.

The operational thread is the **person and the appointment/contact attempt**: verify the person/database, contact them, track whether they responded/appointment was obtained, link an internal referent, and retain a simple outcome.

A proposed rich `dossier commercial` object was therefore rejected for V1.

The user accepted naming the technical object `Prospection` (or equivalent contact tracking) and displaying it as **Suivi de contact**, because the object exists before there is an appointment.

Whether one prospect can have multiple independent historical prospection cycles was asked but not resolved; V1 should keep one current tracking record + history and postpone true multi-cycle behavior.

## J. Interface reframe

The user then stopped database grilling and asked to define actual interface functionality before implementation.

### Home
Global overview with, at minimum, visibility into people/clients contacted, mails/contact attempts, received responses, no-response cases and the next people/actions to contact. Future IProspect/IContact information can eventually appear on Home, but V1 must not mock it.

### Prospection
Dedicated manual-work page. It should show counters specific to the prospecting/database-cleaning activity, such as total people, people left to verify/contact, and similar states.

Counters should be interactive: click a card and the people list filters immediately.

The central list should be people-oriented. Clicking a person opens a large overlay/drawer using the same form as Add Prospect, prefilled with existing information.

The operator must immediately see what is missing/unverified/stale. The user emphasized visual feedback (e.g. yellow warning treatment) and low-effort data entry. Saving should write to the database with timestamp/actor attribution, conceptually the same as a future agent mutation.

Import Excel and Export Excel actions belong here. `Enregistrer et suivant` was recommended for queue processing and accepted as part of the overall direction.

### Database
The user explicitly wants a serious Database Explorer inspired by DBeaver/data-scientist workflows, not a toy admin table:
- left rail of tables;
- large table/grid using available screen space;
- filters, search, hide/reorder/resize/pin columns;
- long text truncated in grid but fully viewable in a small viewer;
- direct edit and delete;
- right-click/context actions, copy values/rows, filter by value;
- safe staged changes with Save/Cancel rather than every keystroke immediately mutating the database;
- FK/relationship navigation where practical;
- metadata visibility;
- discreet SQL query field/console, read-only by default in V1;
- pleasant, spacious UX rather than overly stacked/dense UI.

The distinction was accepted: **Prospection = humans/workflow; Database = raw technical data manipulation**.

### Settings
Internal referents, Roles, Activity Categories and Commercial Segments should be maintained away from the Prospection page in Settings.

### Exploitation
Create the route/page but only as an explicit Coming soon placeholder. No mock features that will need to be thrown away.

## K. Visual direction

The user asked for varied art-direction and logo explorations. Desired vibe: modern, technical/AI, clean, spacious, not overly condensed, with padding and breathing room.

The selected art direction was **Neon Command**: dark charcoal/black surfaces, slate borders, vivid green/teal accents, Inter-like modern typography, restrained neon/glow and clean line icons.

For logo exploration, after several generated options, the user selected the sharp geometric **V-shaped viper mark** from the logo sheet rather than the earlier literal coiled open-mouth snake concept.

The user requested and accepted a family of reusable variants:
- black mark only;
- black lockup with VIPER wordmark;
- white mark only;
- white lockup with VIPER wordmark;
- dark/black mark with neon-green details;
- neon-green-dominant mark with black details.

All accepted variants should remain available because they serve light/dark/contrast situations. The futuristic VIPER wordmark style is also liked and should be used in lockups where appropriate.

## L. Source-of-truth requirements that still matter in this narrower V1

The functional source says VIPER is the human read/control/correction/pilot layer around a shared database. Even though agent/mail/Calendly behavior is deferred, the V1 foundation should retain source/provenance, auditability, secure single-user access, permanent do-not-contact semantics, controlled import and a future-compatible shared data contract.

The source also requires Home/reporting to eventually cover sends/responses/appointments/devis/orders and the 100 contacts / 10 meetings target. In this manual V1, those metrics should only appear when supported by manually recorded contact-tracking data; no fake integration data.

## M. Unresolved items

- exact technology stack and hosting;
- backup/retention/anonymization policy;
- final exact export column ordering after semantic cleanup;
- meaning of legacy `Mode de contact` values and second `A contacter`;
- year for legacy S37/S39 values;
- threshold for declaring verification stale;
- multiple independent contact cycles;
- exact future mail/Calendly/agent integration contracts;
- final pixel-perfect light theme.
