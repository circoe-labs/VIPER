# Interface Spec — V1 (reviewed)

## Global shell

Left navigation: Home, Prospection, Exploitation, Database, Settings — French labels and routes `Accueil` (`/`),
`Prospection` (`/prospection`), `Exploitation` (`/exploitation`), `Base de données` (`/database`), `Paramètres`
(`/settings`); unknown paths redirect to `/` (decision I-08). Desktop-first and spacious. Global search is compact. Theme switch may select dark/light; use accepted logo variant automatically by contrast. Authenticated user context appears separately from Circoe referent selectors.

### Global search — as implemented (Task 17)
One field on the left of the header (placeholder « Rechercher un prospect, une entreprise, un SIREN… »), reached with
**Ctrl+K** or **/**. Results grouped *Prospects* / *Entreprises* / *Établissements* (5 each, best group first) with
their context and badges (*Ne pas contacter*, *Inactif*, *Principal*); ↑/↓, Enter opens (a prospect
`/prospection?prospect=<id>`, a company or an establishment the Company editor), Shift+Enter opens the row in Base de
données, Esc closes then clears. Fields, matching, ranking and API: [global-search.md](global-search.md).

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

### As implemented (Task 16)
KPI definitions, monthly progress, next actions, recent activity and API: [home-dashboard.md](home-dashboard.md).
*État de la base* (*Base*: Prospects, Entreprises, Actifs, Inconnus, Inactifs, Opposition; *Vérification*: Jamais
vérifiés, À revérifier, E-mail manquant / invalide / non vérifié) and *Activité de contact* (*Suivi de contact*: À
contacter, Échus, Contactés, Sans réponse, Réponses, Rendez-vous; *Suivi commercial léger*: Devis envoyé, Suivi du
devis, Gagné, Pas intéressé) as link cards — every prospect count is the Prospection segment it opens
(`/prospection?segment=…`, stages `?tracking_status=…`, Entreprises `/prospection/companies`); then *Prochaines
actions* (appointments of the next 7 days, due contacts, answers without appointment — each person opens in its
Prospection queue); then three equal panels: *Progression du mois* (first contacts and appointments obtained this
month against the informative 100 / 10 targets, six-month columns, a table view), *Derniers imports* and *Dernières
modifications*; one sentence says e-mail sending, Calendly and agents are not part of V1. An empty base shows an
invitation to import instead of figures.

## Prospection

### Header/actions
Search, filters, `+ Ajouter un prospect`, `Importer Excel`, `Exporter Excel`.

### Actionable counters
Counter clicks immediately filter the list. Include coherent subsets such as total, never verified, stale/needs re-check, Active, Unknown, Inactive, due to contact, contacted, responses, appointments.

### Prospect list
People-oriented readable rows/cards, not a raw table. Show: identity, Role/exact title, company, activity status, employment verification date, primary email state, planned contact date, contact-tracking status, referent when relevant.

### As implemented (Task 14)
Segments, counters, criteria, URL and open-editor contract: [prospection-kpis.md](prospection-kpis.md). Header
*Entreprises*, *Importer Excel*, *Exporter Excel*, *+ Ajouter un prospect* (disabled until Task 15); 16 counter cards
in three groups (*Base*, *Vérification*, *Suivi de contact*) that toggle the list's segment; search, *Filtres* (role,
activity, contact stage, referent, company, import) and sort; one card per person (identity, role · exact title,
activity and verification badges, company, primary e-mail state, phone, stage, planned date + week, due, referent,
do-not-contact). All state in the URL (`?segment=due&q=…&page=2`); opening a person sets `?prospect=<id>` — until Task
15 it opens their row in the Database Explorer.

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

Implemented by Task 07 — fields, rules, API and behaviour: [company-editor.md](company-editor.md). One wide drawer for
the whole app, opened with `useCompanyEditor()` (Prospect editor, global search); a compact **Entreprises** list at
`/prospection/companies`, a secondary page of Prospection (no sixth navigation section; linked from the Prospection
header). Sections *Identité*, *Classification*, *Établissements* (repeater, exactly one primary),
*Contexte Circoe*, *Prospects associés* (count + list); dirty-state footer, save keeps the drawer open, Ctrl+S / Enter
save, closing with changes asks first; delete only without prospects.

## Database

### Left rail
Table list + search + selected state + row counts.

Read features, exposure policy, filter operators, limits and export as implemented: [database-explorer.md](database-explorer.md).

### Grid/read ergonomics
Large usable canvas; sticky headers; horizontal/vertical scrolling; pagination/virtualization; search; per-column filters; multi-column sort; hide/show/reorder/resize/pin; visible row/PK context; long text truncation; full-value viewer; copy cell/row; filter-by-value; FK navigation; refresh; filtered export; column metadata/types/nullability/PK/FK.

### Editing
Inline edit with staged pending changes, Save/Cancel bar, add row where safe, delete with confirmation and FK diagnostics, multi-select only for safe operations, audit all mutations. Never bypass durable do-not-contact protections via casual row replacement/import behavior.

As implemented (Task 12): [database-explorer.md](database-explorer.md#staged-editing-task-12).

### SQL
Compact read-only SQL console. Backend must enforce read-only/SELECT behavior; this is not a full SQL IDE or migration tool.

As implemented (Task 13): [database-explorer.md](database-explorer.md#sql-console-task-13).

## Exploitation
Coming soon only. No fake agent controls, drafts, messages or metrics.

Implemented by Task 18: `/exploitation` renders `frontend/src/exploitation/ExploitationPage.tsx` — the page `<h1>`
*Exploitation*, then one empty-state block (`<h2>` *Bientôt disponible*) saying the area will later host the
exploitation of the prospect base by future agents, that nothing is active (VIPER launches no action and sends no
message) and that the base is maintained from Prospection and Base de données. No button, link, form, list, table,
figure or date; the navigation item is current. Replace the component when the area is built.

## Route map

| Path | Page | Navigation item |
|---|---|---|
| `/login` | Connexion (public) | — |
| `/` | Accueil: global dashboard (Task 16) | Accueil |
| `/prospection` | Prospection: counters, filters and people list (Task 14) | Prospection |
| `/prospection/companies` | Entreprises list + Company editor (Task 07) | Prospection |
| `/exploitation` | Exploitation — Bientôt disponible (Task 18) | Exploitation |
| `/database/:table?` | Base de données (Task 11) | Base de données |
| `/settings/:section?` | Paramètres (Task 06) | Paramètres |
| `/_dev/ui` | Component showcase (development server only) | — |
| anything else | redirect to `/` | — |

## Settings
Manage Roles, Activity Categories, Commercial Segments and Internal Referents: search/list/add/rename/deactivate. Inline creation from forms should use the same services. Do not merge internal referents with login users.

Implemented by Task 06 — behaviour, API and pickers: [settings-taxonomies.md](settings-taxonomies.md). `/settings`
shows a tab bar of the four sections (`/settings/roles`, `/settings/activity-categories`,
`/settings/commercial-segments`, `/settings/referents`) above one panel: add, search, *Tous/Actifs/Inactifs* filter,
usage count, status badge, inline rename, deactivate/reactivate, delete only when unused (otherwise deactivation is
proposed). Record editors pick values with `TaxonomySelect`, `TaxonomyMultiSelect` and `ReferentSelect`, which offer
« Créer « … » » through the same audited API.
