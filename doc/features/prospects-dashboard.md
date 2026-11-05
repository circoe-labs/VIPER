# Prospects dashboard (October 2026)

The original `/prospection` workspace has been restored (overview, review panels, original cards,
cohort filters, import/export and the existing prospect editor). Its records are no longer subject
to an imposed verified-only filter. Existing status filters and deep links remain available.

The redesigned dashboard is now a separate navigation entry, **Prospects validés**, at
`/contacts-joignables` (the existing URL is retained). It follows **the validated box in
Prospection → Vérification**, not the stricter employment + verified-primary-email review and
not the channel-based reachability filter.

The shared `verification_validated()` predicate requires an employment verification date and
excludes `ignored` records. It matches the Verification calculation
`total - never-verified non-ignored - ignored`. An unverified, invalid or missing e-mail does
not remove a manually validated record from this workspace. All records in the table are labelled
“Validé” on this basis; the legacy strict API `review` field remains unchanged for other consumers.

The new list and every dashboard aggregate use `validated_only=true`. Reset, search, pagination,
service filters and editor navigation preserve this scope. Ignored and uncertain records remain
in the original database, outside this workspace; no separate base or deletion is created.
On 2026-10-29 the read-only reconciliation found exactly 640 records, including 249 with an
unverified primary email and five without a primary email. All 13 pages matched the Verification
population, without duplicates. The count remains dynamic, not a hardcoded value.

The original `/prospection` page and the two workspaces' shared editor are unchanged.

The validated dashboard shows the summary cards and the prospect list; the distribution chart
also shows the uncertain count used by Verification, alongside the validated count. The list
and quality score remain scoped to validated prospects. The sending-progress
and proposed-service filter panels are not displayed. Service interests remain editable in
the company contacts table, and existing filter links and API parameters continue to work.

The validated list is grouped by company id, with a company header followed by its contacts.
The server sorts the full filtered population by company name, company id and contact name
before pagination. Namesake companies remain distinct; prospects without a company are grouped
under “Sans entreprise”. Search/reset/editor navigation retain this company ordering. Pagination
still counts prospects (50 per page), so a company can continue onto the following page.
Company groups start collapsed. Each heading has a native keyboard-accessible button with an
arrow, `aria-expanded` and `aria-controls`, to reveal/hide its contact rows independently.
Expansion state is kept per company while using the list; hiding a group never changes its data.

## Contracts and mappings

- **Validé in the new workspace** means the existing Verification box (employment checked,
  not ignored), independently of e-mail verification. The list and scoped dashboard share this
  predicate. The legacy `review=verified|to_verify|ignored` contract remains available and unchanged
  on the original Prospection page; it must not be used to narrow this new workspace.
- **Fiabilité** is the existing **data quality** score, not the manual interest score from notes.
  Its SQL expression follows the same nine criteria and configurable bands (`DataQualityConfig`):
  default red below 50, green from 80. Email fallback is now deterministic by id if no primary
  address exists. Backend tests compare SQL with the canonical Python implementation.
  Average: arithmetic mean over currently held, non-opposed prospects, including zero scores.
  The denominator is displayed. No eligible records means `null` / “Aucun score disponible”.
- Send counts represent distinct prospects with a message actually `sent` at rank 0, 1 or 2,
  across **all sequences**, including closed ones. They are cumulative milestones and can overlap;
  the dashboard API reports these counts. Validated, scheduled and draft emails never count as sent. Filtering
  a milestone uses exactly the same predicate. The row shows the highest sent rank, capped
  visually at R2; later sends remain in the existing editor history. No sending action is added.
- “À traiter” uses the existing `due` predicate and its contactability/eligibility rules. It is
  a work queue, not a fourth send step. No weekly/cohort grouping appears in this dashboard.
- Statistics describe the Verification-validated base, independently of additional list filters. The list title and pagination
  describe the filtered subset. Existing segment deep links continue to work.
- Category uses the existing `company_kind` rule and editor. Missing historical classifications
  appear as “À renseigner”; no classification is fabricated. Robin knowledge remains accessible
  through the existing “Qui connaît Robin ?” workflow under “Outils de la base”.

## Company service interests

Migration **0019** adds `companies.proposed_services`, a non-null string array defaulting to empty,
with a database constraint allowing only `iguard`, `flexisme`, `transepteur`, `iadvice`, `emailing`,
and a GIN index. It changes no existing business data or scheduling model.

Membership records an identified interest. Absence means **no identified interest**, not a
confirmed rejection. Multiple memberships coexist. No prospect-level copies are introduced;
all employees of the company read the same array. Interlocutor-specific nuances can still be
recorded in the existing prospect notes, without overwriting the company's identified needs.

Authenticated endpoints, using existing CSRF and audit protections:

- `GET /api/companies/{id}/services`: current memberships.
- `PUT /api/companies/{id}/services/{code}`, body `{ "identified": true|false }`: edit only one
  membership while locking the company row. Concurrent edits of other services are preserved.
  The mutation is audited as `company.updated`, with its before/after values in company history.
  The normal company replacement endpoint does not overwrite memberships.
- `GET /api/prospection/dashboard`: SQL aggregates for total, reviews, sends, due and quality.
- The existing prospects endpoint adds category, interests, quality score/band and historical
  send stage for the requested page only. Additional query parameters: repeated `services`,
  `send_stage=sent|r1|r2`, `company_kind=sme|large|institutional`, and `validated_only=true`.

Multiple service filters use **OR** (at least one selected interest). They combine with search,
review, category and other filters using AND. URL parameters preserve filters and pagination when
opening/closing the existing editor. Mutations refresh both company and prospect query caches.

## Components and validation

Reused: AppShell/Sidebar/GlobalSearch/UserMenu, PageHeader, Button, SearchField, SelectField,
Modal (focus trap/restore), ScoreRing, prospect editor and its Save & Next queue, import/export.
New: `ProspectsDashboard`, `ServiceInterestEditor`, shared service metadata, dashboard CSS.
The legacy OverviewPanel remains available to other consumers but is no longer used by this page.

Backend tests cover real counts, score parity, permissions, invalid service codes, OR filtering,
audit and shared memberships. Frontend tests cover controls, loading/errors, URL state, pagination
and existing editor integration. Playwright checks persisted multi-selection, shared contacts,
responsive overflow, real dashboard totals, axe accessibility, search/pagination and editor return.
Screenshots are written to `frontend/test-results/screenshots/` by the browser tests.

## Files touched by this redesign

Frontend production:
`src/prospection/ProspectionPage.tsx`, `ProspectList.tsx`, `ProspectionFilters.tsx`,
`ProspectsDashboard.tsx`, `ServiceInterestEditor.tsx`, `services.ts`, `criteria.ts`,
`prospects-dashboard.css`; `src/api/prospection.ts`, `src/api/companies.ts`;
`src/shell/Sidebar.tsx`, `navigation.ts`, `shell.css`; `src/theme/tokens.css`.

Backend production:
`app/api/routes/prospection.py`, `app/api/routes/companies.py`, `app/models/companies.py`,
`app/services/prospection/query.py`, `app/services/prospection/dashboard.py`,
`app/services/prospect_data_quality.py`, `app/services/history.py`;
`migrations/versions/0019_company_services.py`.

Tests and supporting documentation:
`backend/tests/test_prospects_dashboard.py`;
frontend ProspectionPage, ServiceInterestEditor, OverviewPanel, criteria, AppShell,
RequireAuth, CompaniesPage and ImportPage tests; the prospection API stand-in and a redundant
assertion removed from the Contact API stand-in;
`e2e/prospection.spec.ts`, with selectors updated in shell, design, home, keyboard and
prospect-editor specs; `doc/features/interface-spec.md`, `prospection-kpis.md`, and this file.

The working branch is `lucie`. Other pre-existing working-tree changes were preserved; this is
not an inventory of all uncommitted work in the checkout.
