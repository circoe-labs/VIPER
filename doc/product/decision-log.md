# Decision Log

> Living copy of the handoff decision log. Sections *Locked by the grill session* and *Requirements retained* are
> the human decisions from the handoff and must not be changed without explicit product approval. New decisions are
> appended under *Implementation decisions* with date, owner and rationale.

## Locked by the grill session

| # | Decision | Notes |
|---|---|---|
| 1 | V1 prioritizes database + interface + Excel/CSV round-trip | Automated prospecting/exploitation is explicitly postponed. |
| 2 | Excel is an import/export contract, not the internal schema | Normalize internally; do not reproduce legacy semantic mistakes. |
| 3 | Prospect = individual person; Company = employer/context | A company may have multiple prospects. |
| 4 | Referent and verification are separate concepts | `Référent` must only contain an internal Circoe person. |
| 5 | Prospect activity = `Active / Inactive / Unknown` | Separate from whether the information was verified. |
| 6 | Verification uses a nullable date | No date means never verified. |
| 7 | Company/employment verification and contact-channel verification are separate | Avoid one overloaded verification flag. |
| 8 | Emails use a separate alias table | Multiple emails, one active primary, own verification/source metadata. |
| 9 | Phones use the same separate-record pattern | Type, primary flag, verification/source metadata. |
|10 | `Fonction` becomes UI label `Rôle` | Role is an administrable taxonomy, with exact job title preserved separately. |
|11 | Unknown roles are suggested, not silently created on import | User can map/create/leave unclassified. |
|12 | Company supports one commercial segment and multiple activity categories | Both are distinct dimensions; taxonomies are administrable. |
|13 | SIREN/SIRET are supported from V1 and optional | Stable business identifiers when available. |
|14 | Company and Establishment are separate | Prospect is not directly linked to an establishment in V1. |
|15 | Legacy week codes become a real planned-contact date | Week number is derived for display; ambiguous year must not be invented. |
|16 | Legacy RDV/devis/suivi/relance booleans collapse to lightweight contact-tracking state | Preserve transition history; no rich CRM dossier. |
|17 | Technical object is `prospection`/contact tracking; UI wording is `Suivi de contact` | It exists before an appointment exists. |
|18 | Referent is nullable and relevant once a meeting is obtained/taken over | Future Calendly may set it automatically; V1 is manual. |
|19 | Home is a global dashboard, not merely an inbox | It still surfaces next actions. |
|20 | Prospection is a readable people list, not a dense spreadsheet | Counters act as filters; prospect opens in a large editor drawer/modal. |
|21 | Database is a genuine advanced data explorer | DBeaver-like inspection/editing is a core requirement. |
|22 | Exploitation route exists as Coming soon only | No fake IContact features. |
|23 | UI must give strong visual feedback for imported/unverified/stale dynamic information | Prefilled fields and minimal-effort manual verification are central. |
|24 | Same form component handles add/edit; Save & Next is desired | Preserve active queue/filter context. |
|25 | DA = Neon Command | Modern, dark-first, spacious, clean, neon accents used selectively. |
|26 | Selected VIPER identity = geometric V/viper mark | Keep all accepted black/white/neon mark/lockup variants for contrast/theme use. |

## Requirements retained from the source-of-truth for VIPER V1 foundation

These were not contradicted by the grill and must be preserved in the implementation foundation:

- controlled CSV/XLSX import with preview, incomplete-row handling, correction/exclusion and dedup;
- source/date and legal-basis or collection-context provenance for contacts;
- durable do-not-contact/opposition state, distinct from non-interest;
- audit of imports and meaningful mutations;
- one securely authenticated commercial user for the pilot, without overbuilding RBAC;
- a shared-data contract able to serve future IProspect/IContact;
- Home/reporting can show monthly contacted/appointment progress from manual data, but must not fake future agent/email integrations.

## Deferred / unresolved

- ~~exact frontend/backend/database stack~~ — resolved by I-01, see [ADR-0001](../adr/0001-stack.md);
- exact hosting, backup policy and retention/anonymization duration;
- exact final export column order, although the grill established a priority ordering and semantic corrections;
- exact semantics of legacy `Mode de contact` values (`Auto`, `Commercial`, `Commerciale`); preserve raw until mapped;
- conversion of legacy `S37/S39` without a known year;
- multiple independent historical contact cycles per prospect; V1 defaults to one current tracking record + transition history;
- pixel-perfect light-theme art direction; derive it conservatively from Neon Command;
- future mail/Calendly/agent contracts beyond the extension points needed by V1.

## Implementation decisions

| ID | Date | Owner | Decision | Rationale |
|---|---|---|---|---|
| I-01 | 2026-09-10 | Orchestrator (Task 00) | Stack follows existing Circoe conventions (IGuard, Onduline): **FastAPI + SQLAlchemy 2 + Alembic + PostgreSQL 16** backend, **React + TypeScript + Vite** frontend, pytest / Vitest / Playwright. Detailed in ADR-0001. | Handoff: "prefer existing Circoe conventions"; Postgres also gives a database-enforced read-only role for the SQL console (Task 13). |
| I-02 | 2026-09-10 | Orchestrator (Task 00) | The handoff `sources/` folder is git-ignored as a whole; spreadsheets are ignored by default except synthetic fixture folders. The rest of the handoff (`tasks/…`) is committed as a frozen reference. | Repo is public; handoff says never copy `sources/` wholesale into the repo. |
| I-03 | 2026-09-10 | Orchestrator (Task 00) | `doc/` is the living documentation; the handoff folder is a frozen snapshot except `tasks/TODO.md` statuses and per-task implementation reports. | User requirement: technical decisions and human intentions must stay durable for the whole project. |
| I-04 | 2026-09-10 | Orchestrator (Task 00) | User-facing UI copy is **French**; code, identifiers and technical docs are English. | The operator is French-speaking; the spec already uses French UI terms (`Suivi de contact`, `Rôle`, `Enregistrer et suivant`). |
| I-05 | 2026-09-10 | Orchestrator (Task 00) | The `/caveman` and `/coding-guideline` skills required by the handoff are not installed on this machine; `doc/process/agent-brief.md` provides the equivalent coding rules. | Unblock implementation while keeping explicit guidelines. |
| I-06 | 2026-09-10 | Orchestrator (Task 00) | Local Postgres for VIPER is exposed on host port **5442**. | Port 5432 is already used by another local project. |
| I-07 | 2026-09-10 | Orchestrator (Task 00) | Work happens on local branch `claude`; nothing is pushed to the public remote without explicit user approval. | Outward-facing action on a public repo. |
| I-08 | 2026-09-10 | Task 01 | Frontend URL paths use English segments (`/`, `/prospection`, `/exploitation`, `/database`, `/settings`); only visible labels are French (`Accueil`, `Base de données`, `Paramètres`). Backend dev port **8042**, Vite **5173**. | Paths are identifiers (I-04: code in English); ports 8000/5432 are used by other local projects. |
| I-09 | 2026-09-10 | Task 03 | Schema conventions per [ADR-0002](../adr/0002-data-schema-conventions.md): UUID (v7) keys, `timestamptz` with trigger-maintained `updated_at`, fixed value sets as `varchar(32)` + CHECK (not native enums), deterministic constraint names, explicit ON DELETE rules, normalized storage for SIREN/SIRET/emails/domains/phones. | Stable ids for future agents/shared DB; enums that evolve with a one-line migration; integrity enforced whatever the write path (import, Database Explorer, agents). |
| I-10 | 2026-09-10 | Task 03 | `prospects.first_name` and `last_name` are each nullable, with a CHECK requiring at least one non-blank name. `prospects.company_id` is nullable in the database ("normally required" is enforced by services). | Legacy rows may carry only one name part or no resolvable company; a prospect is still a person, so a fully anonymous row is rejected. |
| I-11 | 2026-09-10 | Task 03 | Civility is normalized to `mr` / `ms` (UI `M.` / `Mme`); legacy variants map through explicit import rules, anything else is flagged. | Data model says "nullable/normalized" without values; two codes cover the observed variants. |
| I-12 | 2026-09-10 | Task 03 | Do-not-contact durability is enforced by a database trigger: a `do_not_contact` prospect can only be reset by `clear_do_not_contact` (mandatory reason) and **cannot be deleted** (clear first, then delete). The clearing reason is persisted by the audit event once Task 05 exists (validated but not stored before that). | "Import/merge/new tracking/Database Explorer must not silently reactivate" (security spec, overview); deleting would erase the opposition and let a re-import recreate the person as contactable. Final retention/erasure policy stays open (open question #2). |
| I-13 | 2026-09-10 | Task 03 | Company-change rule: `employment_verified_at` is **cleared** (not superseded); every **active** email/phone is treated as company-dependent in V1 and moves `verified` → `unverified`, keeping `last_verified_at`; `invalid`/`unknown`/inactive channels are untouched; nothing is deleted. Applies to any change of `company_id`. | Overview leaves "clear or supersede" to implementation; NULL already means "current employment context not verified". No reliable signal distinguishes personal from professional channels in a B2B base; re-verifying one extra channel is cheap, missing one is not. |
| I-14 | 2026-09-10 | Task 03 | Email addresses and phone numbers are unique **per prospect**, not globally. | The legacy workbook has duplicate emails across rows; whether they are one person is a dedup decision (Tasks 08/09), not a storage error. |
| I-15 | 2026-09-10 | Task 03 | Provenance: `prospect_sources.collected_at` is NOT NULL (default now = when VIPER obtained the data); `import_batch_id` FK added for structured import provenance; `created_by_actor` is an actor snapshot (`actor_type`, `actor_id`, `actor_display`), as on `contact_tracking_status_history`, `import_batches` and `audit_log`. | The true original collection date of legacy rows is unknown; the import date is known. Actor kinds (human/import/system/agent) share no table, and labels must not change retroactively. |
| I-16 | 2026-09-10 | Task 03 | Import batches: `status` `pending/committed/failed/cancelled`, `committed_at` (required iff committed), `rows_total/rows_imported/rows_skipped`, `sheet_names text[]`, optional SHA-256 `file_fingerprint`; no workbook bytes. `import_row_metadata` is write-once (`created_at` only) and unique per batch/sheet/row. `ActorContext` placeholder lives in `app/core/actor.py` for Task 04 to populate. | Data model lists "row counts, status" without values; Task 09 may refine the status set with a CHECK migration. |
| I-17 | 2026-09-10 | Orchestrator review of Task 03 | **Services flush, callers commit.** Services/repositories never `commit()`/`rollback()`; `unit_of_work(session_factory)` (`app/db/session.py`) owns the transaction, used by `SessionDep` (one request = one transaction, `Depends(scope="function")` so the commit precedes the response) and by CLI/jobs. Amends ADR-0001's "services call `session.commit()`". | Prospect editor save (Task 15), import commit (Task 09) and staged Database Explorer changes (Task 12) must compose several service calls atomically. |
| I-20 | 2026-09-10 | Task 02 | The in-app theme defaults to **dark** and only changes on an explicit user choice (persisted in `localStorage`); the OS `prefers-color-scheme` is not followed for the app, only for the favicon (white mark on dark browser chrome, black mark on light). Styling approach in ADR-0003. | Dark is the authored Neon Command identity and light a conservative derivation (locked #25, deferred "pixel-perfect light theme"); a predictable default avoids users landing on the secondary theme by accident. |
| I-21 | 2026-09-10 | Task 02 | The app ships web-sized derivatives of the six accepted logos (cropped to the artwork, 2x downsampled, alpha kept, C2PA metadata not carried over) generated by `frontend/scripts/optimize-brand-assets.js`; originals stay untouched in the handoff folder. Logo artwork is used as delivered: its neon is a lime (~`#79FA03`) that differs from the UI accent Viper Green `#00E676`. | 1.6 MB → ~420 KB without visible loss; no new logo direction (Task 02 out of scope). Whether the logo neon and the UI green should converge is a product/brand question, not an implementation one. |
| I-22 | 2026-09-10 | Task 02 | "Success/verified" status uses a soft mint (`--color-success-fg`), distinct from the brand Viper Green, and every status badge carries a glyph + text. A development-only component showcase is served at `/_dev/ui` by the Vite dev server and stripped from production builds. | Design system: brand green must not be the universal success colour and status must never be colour-only; the showcase gives later UI tasks and reviewers a live catalogue without shipping it. |
| I-40 | 2026-09-10 | Task 11 | Database Explorer exposure is **default deny**: `EXPOSED_TABLES` allowlists the 16 domain tables; every other ORM table must be listed in `UNEXPOSED_TABLES` with a reason (test-enforced); objects outside the ORM (`alembic_version`, catalogs) are unreachable; non-exposed = 404. Column policy `HIDDEN` / `MASKED` (none used yet; primary keys cannot be hidden). Authentication tables (Task 04) go to `UNEXPOSED_TABLES` on merge. | Credentials and session tokens must never be listable; a new table must be a conscious exposure decision. Task 12 extends the same `ColumnPolicy` with editability. [ADR-0005](../adr/0005-database-explorer-grid.md). |
| I-41 | 2026-09-10 | Task 11 | The explorer is a self-contained adapter in `app/services/explorer/` that builds its own SQLAlchemy Core statements (`statements.py`) from validated query objects, instead of going through `app/repositories`. Read API is **GET only**; the filter AST is a JSON query parameter. | It has no domain entities (generic tables), and repositories importing service-level query types would invert the layering. GET keeps it free of CSRF concerns and makes CSV exports plain links. |
| I-42 | 2026-09-10 | Task 11 | Filter semantics: `contains` / `starts_with` / global search are case-insensitive ILIKE with literal `%` / `_` (not accent-insensitive); text `eq` is exact; `neq` is `IS DISTINCT FROM` (keeps NULLs); JSON/array columns only support text `contains` and NULL checks; datetimes must carry a timezone offset. Row counts and totals are exact `count(*)`. | Predictable for a data explorer ("different from X" includes empty values); exact counts are cheap at V1 scale (50k-row test page < 2 s); estimates/keyset paging only if tables grow by orders of magnitude. |
| I-43 | 2026-09-10 | Task 11 | Explorer CSV export: current filter/search/sort, all rows streamed, UTF-8 **with BOM, `;` separator, CRLF**; text cells starting with `=`, `+`, `-`, `@`, tab or CR are prefixed with `'` except plain signed numbers (phone numbers such as `+33…` stay intact); hidden columns absent, masked columns empty. | French-locale Excel splits on `;` and needs the BOM for UTF-8; imported data is untrusted, so formula injection is neutralized. The business Excel export stays Task 10. |
| I-44 | 2026-09-10 | Task 11 | Page values longer than 240 characters (text, or JSON text form) are truncated and flagged; the record endpoint returns full values; a truncated preview is never offered as a filter value. | Keeps pages light while the value viewer shows everything. |
| I-45 | 2026-09-10 | Task 11 | Grid view state (search, sort, filters, page, page size) lives in the URL; criteria changes replace the history entry, FK hops push one carrying the origin (`Retour à …`). Column layout (order, visibility, widths, left pinning) is per table in `localStorage["viper.explorer.columns.<table>"]`; primary keys start pinned; UUIDs display as `xxxxxxxx…xxxxxxxx` in narrow columns. | Reload, deep links and browser Back work like a real tool; layout is a personal preference, not shareable state. UUIDv7 keys share their time prefix, so the tail is what distinguishes rows. |
| I-46 | 2026-09-10 | Task 11 | Grid built on headless **TanStack Table 8.21.3 + TanStack Virtual 3.14.11** (MIT) with our own markup and CSS (ADR-0005). New accessible `Menu` and `Popover` primitives in `src/ui/`. Ports are env-configurable (`VIPER_WEB_PORT`, `VIPER_API_TARGET`; Playwright: `VIPER_E2E_WEB_PORT` 5180, `VIPER_E2E_API_PORT` 8180, `VIPER_E2E_PYTHON`); Playwright starts its own API (`python -m tests.e2e_server`, synthetic dataset in the `*_test` database) and Vite; the CI e2e job gains Postgres + Python. | AG Grid Community lacks context menu/clipboard; TanStack Table 9 is one month old. Dedicated E2E ports prevent reusing a dev server that points at the dev database; parallel worktrees need distinct ports. |
