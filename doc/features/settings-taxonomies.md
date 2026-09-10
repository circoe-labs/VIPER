# Settings — taxonomies and internal referents (Task 06)

The **Paramètres** page (`/settings`) administers the four lists that record editors pick from: **Rôles** (a
prospect's role), **Catégories d'activité** (a company's activities, several per company), **Segments commerciaux**
(a company's single segment) and **Référents internes** (Circoe people named on contact tracking). Taxonomies are
data, not code: the user extends them from Settings or directly from a form's picker, with the same rules and the same
audit trail.

Decisions: I-32 … I-36 in the decision log. Uniqueness mechanism: [ADR-0009](../adr/0009-settings-value-uniqueness.md).

## Rules

| Rule | Behaviour |
|---|---|
| **Stable identity** | A value is referenced by its UUID. Renaming changes the `label` only; the id and every reference stay. |
| **Slug** | Generated once from the label at creation (`Responsable qualité` → `responsable-qualite`, suffixed `-2`, `-3`… when taken, `valeur` when the label has no letter or digit) and **never rewritten on rename**. It is the stable machine key used by the seed (and later by imports/agents); users never see it. |
| **Duplicates** | Two values of one taxonomy may not share a label **ignoring case, accents and spacing** (`Entrepôt` = ` entrepot `, `Cœur` = `coeur`), inactive values included — the user reactivates instead of duplicating. Each taxonomy has its own labels (a role and a segment may both be called `Logistique`). |
| **Stored text** | Labels and names are stored trimmed with inner whitespace collapsed; referent e-mails lowercase. |
| **Deactivation** | `active = false` hides a value from pickers; every record that already uses it keeps it (and a picker still shows it, marked *Inactif*, while it is selected). Reversible (*Réactiver*). |
| **Deletion** | Only when nothing references the value. Otherwise the API refuses with the usage counts (how many prospects use a role, companies use a segment/category, contact trackings name a referent) and the UI proposes deactivation. The database's `ON DELETE RESTRICT` backs this up, even for a reference added meanwhile. |
| **Referents** | First name + last name required, e-mail optional (`x@domain.tld`, stored lowercase). Full names are unique ignoring case/accents/spacing (homonyms would be indistinguishable in a picker); e-mails are unique. Referents are **business records, not login accounts**: no link to `users` in either direction. |
| **Audit** | Every mutation is attributed to the signed-in user (server-side actor) and audited: `role.created`, `role.renamed`, `role.deactivated`, `role.reactivated`, `role.deleted` (same for `activity_category`, `commercial_segment`); `internal_referent.created/updated/deactivated/reactivated/deleted`. Inline creation from a picker produces the same `*.created` event. |

## API — `/api/settings` (session + CSRF, `api_router`)

| Method & path | Body | Answer |
|---|---|---|
| `GET /settings/{taxonomy}` | query `q` (every word must appear, case/accents ignored), `active=true|false` | `[{id, label, slug, active, usage_count, created_at, updated_at}]` ordered by label |
| `POST /settings/{taxonomy}` | `{label}` | 201 value |
| `PATCH /settings/{taxonomy}/{id}` | `{label?, active?}` (at least one) | value — rename and/or deactivate/reactivate |
| `DELETE /settings/{taxonomy}/{id}` | — | 204 |
| `GET /settings/referents` | `q` (names and e-mail), `active` | `[{id, first_name, last_name, email, active, usage_count, …}]` ordered by last, first name |
| `POST /settings/referents` | `{first_name, last_name, email?}` | 201 referent |
| `PUT /settings/referents/{id}` | `{first_name, last_name, email?}` | referent (identity replaced) |
| `PATCH /settings/referents/{id}` | `{active}` | referent |
| `DELETE /settings/referents/{id}` | — | 204 |

`{taxonomy}` is `roles`, `activity-categories` or `commercial-segments`. Business refusals carry a stable `detail.code`
that the UI turns into French copy (`frontend/src/settings/messages.ts`):

| Status | `detail` | UI message (example) |
|---|---|---|
| 409 | `{code: "duplicate", field: "label"\|"name"\|"email", existing: {id, label, active}}` | « Dirigeant » existe déjà. / … existe déjà mais est désactivé : réactivez-le plutôt que de créer un doublon. |
| 409 | `{code: "in_use", usage: {"prospects": 3}}` | Suppression impossible : « X » est utilisé par 3 prospects. Désactivez-le… |
| 422 | `{code: "invalid", field}` | Saisissez un libellé (255 caractères au plus). / Adresse e-mail invalide. |
| 404 | `{code: "not_found"}` | Cette valeur n'existe plus… |

Plain request-validation errors (wrong type, label over 255 characters, empty `PATCH`) are FastAPI's usual 422.

## Code

| Layer | Where |
|---|---|
| Migration | `backend/migrations/versions/0005_settings_uniqueness.py` — `unaccent` extension, `label_key(text)` SQL function, unique indexes `uq_<taxonomy>_label_key`, `uq_internal_referents_name_key`, `uq_internal_referents_email` |
| Services | `app/services/taxonomies.py` (TaxonomyService: `list_values`, `create_value`, `rename_value`, `set_value_active`, `delete_value`), `app/services/referents.py` (ReferentService). Both flush, the request commits; a unique/FK violation that races past the pre-checks is translated inside a savepoint (`errors.translated_violations`). |
| Repositories | `app/repositories/taxonomies.py`, `app/repositories/referents.py` — all comparisons and searches go through `label_key` |
| Router | `app/api/routes/settings.py` |
| Page | `frontend/src/settings/SettingsPage.tsx`, `TaxonomySection.tsx`, `ReferentSection.tsx`, `shared.tsx`, `settings.css` |
| API hooks | `frontend/src/api/settings.ts` (`useTaxonomyValues`, `useReferents`, `useTaxonomyMutations`, `useReferentMutations`) |

## Settings page

- Page header, then a tab bar of the four sections (links: `/settings/roles`, `/settings/activity-categories`,
  `/settings/commercial-segments`, `/settings/referents`; `/settings` shows *Rôles*), each with its number of values.
- Taxonomy section: add strip (*Nouveau rôle* + *Ajouter*; a duplicate shows the French message and, when the twin is
  inactive, a *Réactiver « … »* button), search box + *Tous / Actifs / Inactifs* filter + result count, then a table:
  *Libellé*, *Utilisation* (`3 prospects`, `Non utilisé`), *Statut* (badge with icon + text), actions *Renommer*
  (inline: Enter saves, Esc cancels, focus returns to the row), *Désactiver/Réactiver*, *Supprimer* (confirmation
  dialog; for a value in use the dialog explains why deletion is impossible and offers *Désactiver*).
- Referent section: same list with name, e-mail, usage (`2 suivis de contact`), status; *Ajouter un référent* and
  *Modifier* open a dialog (*Prénom*, *Nom*, *Adresse e-mail* optional) with client-side checks and server refusals on
  the concerned field.
- States: loading, error with *Réessayer*, empty section (explains that forms can create values too), no match. The
  result of the last action is announced in a status region. No optimistic update: the server decides on duplicates
  and usage, then the lists refresh.

## Pickers for record editors (Company editor Task 07, Prospect editor Task 15)

`frontend/src/settings/selectors.tsx`, built on the accessible `Combobox` primitive (`frontend/src/ui/Combobox.tsx`):

```tsx
<TaxonomySelect kind="roles" label="Rôle" value={roleId} onChange={setRoleId} />
<TaxonomySelect kind="commercial-segments" label="Segment commercial" value={segmentId} onChange={setSegmentId} />
<TaxonomyMultiSelect kind="activity-categories" label="Catégories d’activité" value={ids} onChange={setIds} />
<ReferentSelect label="Référent" value={referentId} onChange={setReferentId} />
```

Common props: `hint`, `error`, `required`, `disabled`, `placeholder`, `allowCreate` (default `true`).

- WAI-ARIA combobox + listbox: typing filters (every word, case and accents ignored), ↓/↑ open and move, Enter picks,
  Esc closes (without closing an enclosing dialog), Tab leaves; multi-select shows removable chips, Backspace in an
  empty input removes the last one; single-select has a clear button unless `required`.
- Active values only; an **inactive value appears only while it is selected** (marked *Inactif*). Typing the exact label
  of an inactive value explains that it exists but is deactivated (reactivate it in Paramètres).
- **Inline creation** — the grill's "inline extensibility from forms": when no value carries the typed text, the last
  option is *Créer « … »*. It calls the same audited `POST /api/settings/…` as the Settings page, adds the new value to
  the cached list and selects it; a refusal (e.g. a duplicate created meanwhile) is shown under the field. For
  referents the text is split on its first space (`Jean-Marc De La Test` → first name `Jean-Marc`, last name
  `De La Test`); a single word is refused with a hint. The e-mail can be added later in Paramètres.
- The pickers share TanStack Query caches with the Settings page, so a change in one place shows in the other.
- Live demo, wired to the API, on the development showcase `/_dev/ui` (*Sélecteurs de paramètres*).

## Tests

- Backend: `tests/test_settings.py` (services: create/normalize/slug, duplicates case/accent/space-insensitive incl.
  inactive twins and a race past the pre-check, rename keeps id/slug/references, deactivate/reactivate audited once,
  delete unused vs refused with counts incl. a reference added after the check, list order/filters/search, referents:
  e-mail rules, unique names/e-mails, edit audited, not login accounts), `tests/test_settings_api.py` (401 without
  session, 403 without/with a forged CSRF token, full lifecycle attributed to the signed-in user, 409/422/404 codes),
  `tests/test_schema_constraints.py` (database-level uniqueness).
- Frontend: `src/ui/Combobox.test.tsx` (keyboard, filtering, inactive handling, inline creation and its errors,
  multi-select), `src/settings/SettingsPage.test.tsx` (sections, add/duplicate/reactivate, inline rename, deactivate,
  delete confirmation and in-use refusal, search/filter, error/empty states, referents), `src/settings/selectors.test.tsx`
  (active-only lists, inline creation through the API, referent name split) — against an in-memory fake API
  (`src/test/settingsApi.ts`).
- Playwright `e2e/settings.spec.ts` (real backend): add → duplicate refused → rename → pick in a picker → deactivate →
  gone from the picker; in-use deletion refused, unused deleted; inline creation from a picker then visible in
  Settings; referent added then offered by the referent picker; screenshots of the page in both themes at 1440×900; no
  horizontal overflow at 1280 px.
