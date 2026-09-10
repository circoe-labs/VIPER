# Interface Spec — V1 (reviewed)

## Global shell

Left navigation: Home, Prospection, Exploitation, Database, Settings — French labels and routes `Accueil` (`/`),
`Prospection` (`/prospection`), `Exploitation` (`/exploitation`), `Base de données` (`/database`), `Paramètres`
(`/settings`); unknown paths redirect to `/` (decision I-08). Desktop-first and spacious. Global search is compact. Theme switch may select dark/light; use accepted logo variant automatically by contrast. Authenticated user context appears separately from Circoe referent selectors.

## Home

Purpose: **global view of database health and contact activity**, not an action-only inbox.

Recommended V1 blocks, all from real/manual DB data:
- total prospects;
- never/currently needs verification;
- Active / Unknown / Inactive;
- missing/invalid/unverified primary email;
- planned contacts / due contacts;
- contacted;
- no response (derived from contacted/follow-up state with no response/appointment);
- responses received;
- appointments obtained;
- lightweight quote/follow-up/won counts only if manually recorded;
- monthly progress for contacted prospects and appointments (source requirements target 100 / 10, but do not make 10 meetings the sole dominant UI metric);
- recent imports/edits;
- next actions list.

Cards are clickable when they map to a Prospection filter. Future agent/email/Calendly widgets must not be mocked.

## Prospection

### Header/actions
Search, filters, `+ Ajouter un prospect`, `Importer Excel`, `Exporter Excel`.

### Actionable counters
Counter clicks immediately filter the list. Include coherent subsets such as total, never verified, stale/needs re-check, Active, Unknown, Inactive, due to contact, contacted, responses, appointments.

### Prospect list
People-oriented readable rows/cards, not a raw table. Show: identity, Role/exact title, company, activity status, employment verification date, primary email state, planned contact date, contact-tracking status, referent when relevant.

### Prospect editor
Wide drawer/modal preserving current filtered queue. Reuse same component for create/edit.

Sections:
1. Identity
2. Employment: Company, Role, exact title, activity
3. Verification: employment verified date and clear current/stale state
4. Emails: aliases, primary, verification, origin/source
5. Phones: aliases, type, primary, verification, origin/source
6. Contactability/opposition: durable do-not-contact control clearly separated from activity and current stage
7. Suivi de contact: planned contact, current stage, response date, appointment date, referent (primarily once appointment exists)
8. Company context summary + link/open Company editor
9. Provenance / recent history compactly accessible

Visual feedback:
- imported dynamic information with no verification date: yellow/warning treatment;
- recently verified: subtle positive mark + date;
- stale: warning based on configurable age, not hardcoded business policy unless product confirms it;
- missing: actionable empty state;
- invalid/inactive/do-not-contact: explicit labels/icons, not color alone;
- unsaved changes: dirty-state bar.

Actions: Save, Cancel, Delete if safe/authorized, Save & Next.

## Company editor

Lightweight data-maintenance UI, **not** a CRM company dossier. Create/edit:
- display/legal name, SIREN, website, email domain, size text;
- one commercial segment;
- multiple activity categories;
- establishments with SIRET/address/kind/primary;
- project/reference/approach legacy metadata where useful;
- small list/count of associated prospects for navigation.

Accessible from Prospect editor, global search and optionally Database/Prospection context.

## Database

### Left rail
Table list + search + selected state + row counts.

Read features, exposure policy, filter operators, limits and export as implemented: [database-explorer.md](database-explorer.md).

### Grid/read ergonomics
Large usable canvas; sticky headers; horizontal/vertical scrolling; pagination/virtualization; search; per-column filters; multi-column sort; hide/show/reorder/resize/pin; visible row/PK context; long text truncation; full-value viewer; copy cell/row; filter-by-value; FK navigation; refresh; filtered export; column metadata/types/nullability/PK/FK.

### Editing
Inline edit with staged pending changes, Save/Cancel bar, add row where safe, delete with confirmation and FK diagnostics, multi-select only for safe operations, audit all mutations. Never bypass durable do-not-contact protections via casual row replacement/import behavior.

### SQL
Compact read-only SQL console. Backend must enforce read-only/SELECT behavior; this is not a full SQL IDE or migration tool.

## Exploitation
Coming soon only. No fake agent controls, drafts, messages or metrics.

## Settings
Manage Roles, Activity Categories, Commercial Segments and Internal Referents: search/list/add/rename/deactivate. Inline creation from forms should use the same services. Do not merge internal referents with login users.
