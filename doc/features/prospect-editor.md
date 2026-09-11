# Prospect editor — adding, verifying and updating a person (Task 15)

The Prospect editor is the central low-effort form of the daily work: open a person from Prospection, see at once
what needs verification, confirm or correct it, plan or record the contact, and move to the next person. The same
wide drawer adds a new person. Everything is prefilled; one save writes everything atomically and audited.

Decisions: I-100 … I-109 in the decision log, [ADR-0015](../adr/0015-prospect-editor-save.md). Schema and rules:
[data-model.md](../architecture/data-model.md) (verification contract, contactability, company-change rule I-13).
Open-editor contract and queue: [prospection-kpis.md](prospection-kpis.md#open-editor-contract).

## Entry points

| Where | How |
|---|---|
| Prospection list | A person's name (click, or Enter on the focused card) sets `?prospect=<id>` — pushed, so Back closes the editor; the list stays behind it with its segment, search, filters, sort and page. |
| *+ Ajouter un prospect* | `?prospect=new`: the same drawer, empty (see *New prospect*). |
| Anywhere else | Not yet (global search is Task 17). The Database Explorer keeps its own row editing. |

The implementation is the default of `ProspectEditorContext` (`frontend/src/prospection/prospectEditor.tsx`); the
former explorer fallback is gone.

## Layout

A drawer of 64 rem (`Drawer size="xl"`), two columns — the person on the left, the context on the right (one column
below 1100 px):

| Column | Sections |
|---|---|
| Left | 1 **Identité** (Civilité, Prénom, Nom) · 2 **Emploi** (Entreprise *, Rôle, Intitulé exact, Activité) · 3 **Vérification de l'emploi** · 4 **E-mails** · 5 **Téléphones** |
| Right | 6 **Opposition** · 7 **Suivi de contact** · 8 **Entreprise** (summary + *Ouvrir la fiche entreprise*) · 9 **Provenance** (sources; the change history of Task 19 goes below) |

The header gives the person's name and their place in the queue (*Prospect 3 sur 45 · Jamais vérifiés*). The footer is
the dirty-state bar.

## Field semantics

| Section | Field | Stored in | Rules |
|---|---|---|---|
| Identité | Civilité | `civility` | `M.` / `Mme` / none. |
| | Prénom, Nom | `first_name`, `last_name` | Trimmed, inner spaces collapsed, 100 characters; at least one of them (*Saisissez au moins un prénom ou un nom.*). The typed casing is kept (unlike the import's re-casing). |
| Emploi | Entreprise * | `company_id` | Required to save (server too). Server-side search over **every** company by name; *Créer l'entreprise « … »* opens the Company editor prefilled with the text (its similar-companies warning still applies); the saved company is selected. Changing it applies the company-change rule (below). |
| | Rôle | `role_id` | The normalized classification used by filters. *Créer le rôle « … »* creates the role **with the save** (same rules and `role.created` audit as Paramètres; a cancelled edit creates nothing; an existing label, even deactivated, is refused). |
| | Intitulé exact | `exact_job_title` | The person's own wording, 255 characters. |
| | Activité | `activity_status` | *Actif / Inactif / Inconnue* — in post, left, or not determined. Independent of the opposition and of verification. A new person starts at *Inconnue* (nothing is assumed). |
| Vérification de l'emploi | *Vérifié aujourd'hui*, *ou vérifié le* (date), *Effacer la vérification* | `employment_verified_at` | Covers company, role, exact title and activity. Explicit only: see *Verification*. |
| E-mails, Téléphones | repeaters | `emails`, `phones` | See *E-mails and phones*. |
| Opposition | *Enregistrer une opposition…*, *Lever l'opposition…* | `contactability_status`, `do_not_contact_at`, `do_not_contact_reason` | Dedicated operation, never the save — see *Opposition*. |
| Suivi de contact | Étape | `contact_tracking.status` | *Aucun suivi* until one exists; setting a date alone creates it at *À contacter*. *Depuis le …* = the last status-history entry. A tracking is never deleted from the editor. |
| | Contact prévu le (+ *Aujourd'hui*, *Dans 1 semaine*) | `planned_contact_at` | A day (Europe/Paris); the ISO week is shown (*Semaine 38*). |
| | Réponse reçue le | `response_received_at` | A day. |
| | Rendez-vous le … à … | `appointment_at` | A day and an optional time. |
| | Référent Circoe | `referent_id` | A Circoe internal referent (never a login). Emphasized (warning box + hint) once an appointment exists without one. Inline creation *Prénom Nom* through Paramètres, as everywhere. |
| Entreprise | summary | — | Name, legal name, SIREN, segment, city, e-mail domain, website, prospect count; every change goes through the Company editor (no company field is duplicated here). |
| Provenance | sources | `prospect_sources` | Each source: type, reference (file / sheet / row for imports), collection date, who recorded it, legal basis or collection context; creation and last-change dates. |

## Verification

Two separate scopes (grill decision 7): the **employment context** (one date on the prospect) and **each e-mail and
phone** (own status and date). Identity fields are not re-verified individually.

- **Employment** — the save carries an explicit action: `keep` (default), `verified_now` (*Vérifié aujourd'hui*: now),
  `verified_on` + a day (midnight Europe/Paris; today means now; a future day is refused), `clear`. Its state comes
  from the same expression as the Prospection card (`verification_state`): *Emploi jamais vérifié*, *Valeurs importées,
  jamais vérifiées* (an import source and no verification), *Vérifié le … · ancien* (only when
  `VIPER_VERIFICATION_STALE_DAYS` is set), *Vérifié le … · coordonnées à revérifier*, *Vérifié le …*; a pending action
  shows *… — à enregistrer*.
- **Aliases** — *Vérifié* (one click) sends `verified_now`: status `verified`, dated now by the server. The actions menu
  (⋯) offers *Marquer « non vérifié »*, *Marquer invalide*, *Marquer « statut inconnu »*. A status `verified` without
  `verified_now` is accepted only for an alias that is verified already and unchanged; other statuses keep the last
  verification date. Editing an address or number makes it a new value: never verified, origin *manual*.

### Visual feedback (never colour alone: a glyph and a text every time)

| Situation | Treatment |
|---|---|
| Imported values never verified | Emploi and Vérification sections get a warning edge; Entreprise, Rôle, Intitulé exact get a warning outline and the text *Valeur importée, jamais vérifiée : confirmez-la.*; the Activité choice a warning outline. Aliases: warning edge + *Importé, jamais vérifié*. Sections show counts (*1 à vérifier*). |
| Verified | Subtle success badge with the date (*Vérifié le 3 sept. 2026*) — the mint success colour, not the brand green. |
| Stale | Only when the threshold is configured: *Vérifié le … · ancien* (warning, clock glyph), for the employment and the aliases. |
| Missing | Actionable empty states: *Aucune adresse. Ajoutez…*, *Aucune entreprise choisie*, *Pas encore vérifié*; a new form starts with one empty e-mail and phone line. |
| Invalid / inactive / opposed | *Invalide* (danger), *Ancienne adresse (inactive)* (struck through, neutral), *Ne pas contacter* (danger box with date and reason). |
| Company changed in this edit | Banner *Entreprise modifiée. À l'enregistrement, la vérification de l'emploi est effacée et les e-mails et téléphones vérifiés repassent « à revérifier » ; ils sont conservés, rien n'est supprimé.*; the verification shows *Nouvelle entreprise : emploi à vérifier*; verified aliases *À revérifier (vérifié le …)*. An e-mail outside the company's e-mail domain gets *Domaine différent de celui de l'entreprise (…)*. |

## E-mails and phones

- Repeater cards: the value, (phones) *Type* — *Mobile / Fixe / Autre*, preselected from the French numbering plan
  until chosen —, the *Principal* radio, the state badge, the origin (*Import · base.xlsx / Prospects / ligne 7*,
  *Saisie manuelle*, *Corrigé à la main*, *Nouvelle saisie*), *Vérifié*, the actions menu, and for a new line
  *Source (facultatif)*.
- Values are normalized with the import's rules (`contact_channels.normalize_*`): addresses trimmed and lowercase with a
  valid syntax; French numbers `+33…` (`06 12 34 56 78`, `+33 (0)6…`, `0033 6…`), other international numbers keep
  their digits. The same value twice is refused (*Cette adresse est déjà saisie.*).
- **Exactly one active primary** while any alias is active: the first line added is primary; choosing another moves
  the flag; deactivating or removing the primary hands it to the first active line; the server makes the first active
  alias primary when none is flagged and refuses two, or a primary that is inactive.
- *Désactiver* keeps a former address or number (struck through, never primary); *Retirer (erreur de saisie)* deletes
  the line at the save. A company change never deletes anything.
- The list is saved as a **full list** (a line left out is deleted); a blank new line is simply left out.

## Opposition (durable do-not-contact)

Independent of the activity and of the contact stage (*Pas intéressé* is an outcome, not an opposition). *Enregistrer
une opposition…* and *Lever l'opposition…* open a confirmation with a required reason and call their own audited
operation (`PUT /api/prospects/{id}/contactability`) at once — the form's pending changes stay pending (the dialog
says so). The reason of an opposition is kept on the prospect and in the event; the reason of lifting it only in the
`prospect.do_not_contact.cleared` event (I-28). A new person can be opposed once saved. The save payload cannot carry
contactability at all (unknown fields are refused with 422).

## Company change

Choosing another company applies I-13 at the save, through `prospects.change_company`: `employment_verified_at` is
cleared — unless the same save verifies it again (*Vérifié aujourd'hui* after picking the company) —, every **active**
`verified` alias goes back to `unverified` keeping its date (so it reads *à revérifier*), unless re-verified in the same
save; nothing is deleted; the event `prospect.company_changed` keeps both company names. The editor shows this effect
before saving (banner, states above).

## Saving, Save & Next, conflicts

- **Dirty-state bar** (footer): *Modifications non enregistrées*, *Prospect enregistré.*, *Corrigez les N champs
  signalés.*, *Enregistrement impossible : …*, *Fin de la liste « … » : aucun prospect après celui-ci.*, announced
  through `role="status"`; when idle it lists the shortcuts. Buttons: *Supprimer* (existing person), *Annuler les
  modifications* (back to the saved state) or *Fermer*, *Enregistrer*, *Enregistrer et suivant* (primary).
- **One atomic save**: every section in one request and one transaction; any refusal writes nothing. Errors show on
  their field (server paths such as `emails.1.address` are mapped back to the lines) and the first invalid field gets
  the focus; validation runs in the browser first with the same rules.
- **Enregistrer et suivant** saves when there are changes (otherwise just moves on), then asks the Prospection queue for
  the next person (`ProspectQueue.next`: the list order when the editor opened, read again after a save so a person
  leaving the segment never makes it skip anyone) and opens them in place; at the end of the list the editor stays and
  says so. After every write, `prospectionKeys.all` (counters and pages), companies and Settings caches refresh.
- **Conflicts**: every write sends the version read with the prospect; if the prospect, one of its aliases or its
  tracking changed meanwhile (another tab, the Database Explorer), the save is refused (409) — *Ce prospect a été modifié
  ailleurs depuis son ouverture.* with *Recharger la fiche* — instead of overwriting.
- **Keyboard**: logical tab order (left column, then right); **Ctrl+S / ⌘S** saves, **Ctrl+Entrée** saves and moves
  on (*Enregistrer et nouveau* for a new person), **Enter** in a one-line field saves (like the Company editor; an open
  picker uses Enter to choose), **Échap** closes — asking first when changes are pending (*Abandonner les
  modifications ?*). Shortcuts act only in the editor, not in a dialog above it.

## New prospect

`?prospect=new`: empty form, activity *Inconnue*, one empty e-mail and phone line, and the **provenance** fields —
*Contexte de collecte ou base légale* * (default « Saisie manuelle — prospection B2B », editable) and *Où avez-vous trouvé
ce contact ?* (optional). The save records a `manual` source collected now by the signed-in user. *Enregistrer* keeps the
drawer on the created person; *Enregistrer et nouveau* opens a fresh form keeping the company and the provenance texts
(entering several people of one company). The opposition waits for the first save.

## Deletion

*Supprimer* opens a confirmation listing what goes with the person (*1 téléphone, le suivi de contact et son historique,
1 trace de provenance, 1 ligne d'import d'origine*); the company stays. An **opposed** person cannot be deleted
(*Suppression impossible* explains why: a later import could recreate them as contactable — lift the opposition first,
with its reason). One `prospect.deleted` event; the cascaded rows are not audited one by one (ADR-0006 limit).

## API — `/api/prospects` (session + CSRF, `api_router`)

| Method & path | Body / query | Answer |
|---|---|---|
| `GET /prospects/{id}` | — | The view model: identity, `company` summary, `role`, employment and `verification_state`, `employment_imported_unverified`, contactability, `emails` / `phones` (primary first, each with `imported_unverified`), `tracking` (days in business time, `appointment_time`, `planned_contact_week`, `referent`, `status_since`), `sources` (oldest first, with the import file name), `import_row_count`, `today`, `stale_threshold_days`, timestamps, **`version`** |
| `POST /prospects` | the form + `provenance: {legal_basis_or_collection_context, source_reference}` | 201 view |
| `PUT /prospects/{id}` | `version` + the whole editable state; `emails` and `phones` required (full lists) | view |
| `PUT /prospects/{id}/contactability` | `{do_not_contact, reason, version}` | view |
| `DELETE /prospects/{id}?version=…` | — | 204 |

Form fields: `civility`, `first_name`, `last_name`, `company_id`, `role_id` or `role_label` (new role), `exact_job_title`,
`activity_status`, `employment_verification: {action: keep|verified_now|verified_on|clear, day}`, `emails: [{id?,
address, is_primary, is_active, verification_status, verified_now, source_reference}]`, `phones: [{…, number, type}]`,
`tracking: {status, planned_contact_on, response_received_on, appointment_on, appointment_time, referent_id} | null`
(null leaves the tracking as it is). Unknown fields are refused (422).

Refusals (`app/api/errors.py`, French copy in `frontend/src/prospects/messages.ts`):

| Status | `detail` | Example |
|---|---|---|
| 422 | `{code: "invalid", field, reason}` — `field` e.g. `last_name` (`blank`), `company_id` (`blank`, `unknown`), `role_id` (`unknown`), `role_label` (`length`, `both`), `employment_verification.day` (`blank`, `future`), `emails.N.address` / `phones.N.number` (`blank`, `format`, `repeated`), `emails.N.is_primary` (`multiple`, `inactive`), `emails.N.verification_status` (`verification_action`), `emails.N.id` (`unknown`), `phones.N.type` (`blank`), `emails` (`exchange`: two lines swapping values), `tracking.referent_id` (`unknown`), `tracking.appointment_time` (`without_day`), `provenance.legal_basis_or_collection_context` (`blank`), `reason` (`blank`) | *Adresse e-mail invalide (ex. prenom.nom@exemple.fr).* |
| 409 | `{code: "duplicate", field: "role_label", existing}` | *Le rôle « Dirigeant » existe déjà : choisissez-le dans la liste.* |
| 409 | `{code: "conflict"}` | *Ce prospect a été modifié ailleurs depuis son ouverture…* |
| 409 | `{code: "do_not_contact"}` (delete) | *Suppression impossible : ce prospect est en opposition…* |
| 404 | `{code: "not_found"}` | *Ce prospect n'existe plus…* |

## Audit

Every write is attributed to the signed-in user (`source=ui`, one `request_id` per save), one event per changed row:
`role.created` (inline role), `prospect.company_changed` (both company names, `employment_verified_at` cleared, each reset
alias its own `email/phone.updated`), `prospect.updated` (identity/employment fields; a role change carries both role
labels), `email/phone.created/updated/deleted`, `contact_tracking.created/status_changed/updated` (+ status history),
`prospect_source.created` (creation), `prospect.do_not_contact.set/cleared` (`context.reason`), `prospect.deleted`. A save
that changes nothing writes nothing.

## Code

| Layer | Where |
|---|---|
| Services | `backend/app/services/prospect_editor.py` (view model, `create_prospect`, `update_prospect`, `set_contactability`, `delete_prospect`, `aggregate_version`), `backend/app/services/contact_channels.py` (alias normalization and full-list save), existing domain operations in `prospects.py`, `contact_tracking.py`, `provenance.py`, `taxonomies.py` |
| Repositories | `backend/app/repositories/prospects.py` (`lock_prospect`, `version_rows`, `sources_with_batches`, `count_import_rows`), `companies.company_summary`; `prospection.query.prospect_verification_state` |
| Router | `backend/app/api/routes/prospects.py` |
| Frontend | `frontend/src/prospects/` (`ProspectEditor`, `EmploymentSections`, `AliasList`, `TrackingSection`, `OppositionSection`, `ContextSections`, `pickers`, `EditorSection`, `prospectForm.ts`, `verification.ts`, `messages.ts`, `prospects.css`), API hooks `frontend/src/api/prospects.ts` |

## Tests

- Backend: `tests/test_prospect_editor.py` (creation with manual provenance and one event per row, required name /
  company / context, identity edit, unchanged save writes nothing, inline role audited and labelled, duplicate role,
  every verification action and the future/missing date, alias add + primary switch without clash, deactivated primary
  handed on, removal, every alias refusal, phone refusals, one-click verification and status changes, edited address,
  company change clearing and resetting with old/new labels, only explicit re-verification after a company change,
  tracking days/time/referent/history, unchanged day keeps the stored moment, appointment time and unknown referent,
  opposition set/lifted only with a reason, the save never touching an opposition, stale version refused for save /
  contactability / delete, deletion cascade with one event, opposed prospect not deletable, imported flags and
  provenance in the view), `tests/test_prospects_api.py` (401 on every route, 403 without/with a forged CSRF token,
  lifecycle attributed to the signed-in user with `source=ui`, contactability refused in the save payload, a failing alias
  rolling back role + company + identity, stable refusal codes, concurrent change → 409, delete refused then allowed).
- Frontend: `src/prospects/prospectForm.test.ts`, `verification.test.ts` (pure rules and labels);
  `ProspectEditor.test.tsx` (prefilled sections, imported warning treatment and one-click verification, verified state,
  one-request save + list refresh, dirty bar / revert / guarded Esc, refusal on its field, conflict reload),
  `ProspectAliases.test.tsx` (add + make primary, deactivate/remove through the menu, phone type from the number, company
  change effect), `ProspectOpposition.test.tsx` (set/lift dialogs with reason, blocked and allowed deletion),
  `ProspectSaveNext.test.tsx` (Save & Next through a queue, Ctrl+Entrée without changes and the end of the list),
  `ProspectCreate.test.tsx` (creation with provenance and *Enregistrer et nouveau*, required fields, company created
  through the Company editor), `ProspectTracking.test.tsx` (role created with the save, planned week and referent
  emphasis) — against `src/test/prospectsApi.ts` and `src/test/renderProspectEditor.tsx`.
- Playwright `e2e/prospect-editor.spec.ts` (real backend, its own imported people): open from the list, verify the
  employment, add a second e-mail made primary, plan a contact and a stage, Save & Next to the next person of the
  filtered queue; add a person with a company created inline; record an opposition and find it under *Opposition*;
  screenshots of the warning and verified states in both themes at 1440×900 and 1280×800.
