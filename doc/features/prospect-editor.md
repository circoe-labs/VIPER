# Prospect editor — adding, verifying and updating a person (Task 15)

The Prospect editor is the central low-effort form of the daily work: open a person from Prospection, see at once
what needs verification, confirm or correct it, plan or record the contact, and move to the next person. The same
wide drawer adds a new person. Everything is prefilled; one save writes everything atomically and audited.

Decisions: I-100 … I-109 in the decision log, [ADR-0015](../adr/0015-prospect-editor-save.md); history and
provenance (Task 19): I-130 … I-137, [ADR-0018](../adr/0018-readable-history.md). Schema and rules:
[data-model.md](../architecture/data-model.md) (verification contract, contactability, company-change rule I-13).
Open-editor contract and queue: [prospection-kpis.md](prospection-kpis.md#open-editor-contract).

## Entry points

| Where | How |
|---|---|
| Prospection list | A person's name (click, or Enter on the focused card) sets `?prospect=<id>` — pushed, so Back closes the editor; the list stays behind it with its segment, search, filters, sort and page. |
| *+ Ajouter un prospect* | `?prospect=new`: the same drawer, empty (see *New prospect*). |
| Global search (Task 17) | A prospect result (Enter or click) opens `/prospection?prospect=<id>`: the same drawer over the Prospection list ([global-search.md](global-search.md)). |
| Database Explorer | Keeps its own row editing. |

The implementation is the default of `ProspectEditorContext` (`frontend/src/prospection/prospectEditor.tsx`); the
former explorer fallback is gone.

## Layout

A big **centered floating window** (UI2): `Modal sheet size="xl"` of `ui/Dialog` — the `sheet` variant adds a dimmed and slightly
blurred backdrop, a 20 px radius, a soft large shadow, a fixed height (`min(100%, 58rem)`, it never resizes between tabs or states),
margins on every side, and scrolls inside its body only (no horizontal scroll). The other dialogs and drawers are unchanged. A
custom header replaces the title block (`heading` prop of the dialog, which must carry the dialog's accessible name): **avatar with
initials, the full name large, « fonction · entreprise | e-mail principal »** (all following the form's draft), and on the right
*Mission*, *Contacter*, a **« … » menu** (the same actions as the right-click menu: *Lier à…*, *Mission*, *Contacter*, *Réévaluer le
score*, *Graph*, *Société*, built once by `useSheetMenu`) and the close button. The queue position (*Prospect 3 sur 45 · Jamais
vérifiés*) is in the footer next to the arrows. The two tabs (`ui/Tabs`, decision D-UX1) sit right under the header; the form, the
draft and the footer are shared by both tabs. Profil is a stack of rows that use the whole width, one gap, equal columns and cards
stretched to the same height (`ProfileLayout.tsx` / `profile-layout.css`: `ProfileRow` with 1, 2 or 3 columns; the rows stack when the
panel is narrower than 54 rem — a container query on the panel, `container: sheet`). All cards of both tabs share one language
(`prospect-sheet.css`): radius 14 px, padding 20 px, gap 20 px, icon + title, *Modifier* buttons, label / value rows. Explanations go
in info tooltips (`ui/InfoTip`), not in paragraphs. Footer: *Supprimer*, *Enregistrer*, *Enregistrer et fermer*, the arrows.

| Tab | Row | Content |
|---|---|---|
| **Profil** | KPI row (3 cards of one fixed height, 11 rem) | In this order: **Score prospect** (`ProspectScoreCard`, owned by the score module: commercial fit only, ring + word + detail dialog; absent for a new person; **« Non évalué »** placeholder while `score.contributions` is empty, with the action reading **« Évaluer »**; it fills the card the strip gives it) · **Score de proximité** (big ring 0-100 + band word *Proche / Accessible / Lointain* + *N chemins* + the best path's ends « Membre → Prospect » (the full path in its tooltip) + a **« Voir le graphe »** button, from `GET /api/links/proximity/prospect/{id}`; explained *empty* / *unreachable* states; error with *Réessayer*; the button is hidden when there is no relation — `prospectGraphHref(id)`, `?focus=prospect:<id>` read by `GraphPage`) · **État de la fiche** (the state word big, a small sober icon tile in the state's tone — one icon per state — and **one sentence built from the backend's real criteria** (`criteriaSentence`: what is acquired, then what lacks, e.g. *E-mail vérifié · fonction et entreprise renseignées · aucun téléphone actif*); no number, the « à compléter » list is in the info tip; *Écarté* under opposition). The three cards have the same padding, the same height whatever the state (loading, empty, error and ready replace the content in place), and stack in the same order when the panel is narrower than 52 rem. `ProspectIndicatorStrip.tsx` + `indicator-strip.css`; the slots take an `IndicatorState` (`loading` / `unavailable` / `error` / `ready`, `indicators.ts`) from the one seam `indicatorSources.ts`. The front computes no score. |
| | two columns | **Résumé** (`ProfileSummary`, region « Résumé du profil »: a few lines of synthesis written by the pure `summarizeProspect` (`sheetSummary.ts`, tested) from real data — role at company, fiche state, e-mail verified?, proximity paths, score status; never the name, never an invented value; *Copier les informations*; hidden for a new person) · **Coordonnées** (read view: one row per e-mail and phone with its verification state — *Principal* only when there are several —, *Aucune adresse* / *Aucun numéro*; *Modifier* opens the existing E-mails / Téléphones inputs) |
| | three columns | **Identité** (Civilité, Prénom, Nom) · **Emploi** (Rôle, Intitulé exact, Activité; the company is in the next card and edited from this one) · **Entreprise** (name with an icon button *Ouvrir la fiche entreprise*, legal facts, Ville, Domaine e-mail, Site web) |
| | one column | **Relations N** (`ProspectLinksCard`): rows with initials avatar, name, relation chip, the **« Meilleur chemin »** chip + *N chemins* on the relation that opens the best path (from the proximity read model, no second graph), strength meter; *Lier à* (inline add, edit and delete per row) and **« Voir toutes les relations »** (opens the graph) |
| **Suivi** | top, full width | **Synthèse du suivi** (`TrackingOverview`, prospect-sheet redesign S6; same card language as Profil): read-only band — *État commercial* (+ *depuis le*), *Prochaine action* (next send and due date, *Échu*, or *Aucun envoi prévu* with the reason in an info tip), *Semaine* (+ first send), *Réponse*, *Rendez-vous*, *Référent*. It follows the form's live values. Hidden for a new person. |
| | row 1 | **Suivi de contact** (state form, with the *Ne pas contacter* banner) · **Séquence de contact** — equal cards |
| | row 2 | **Notes** · **Alertes qualité** — equal cards |
| | row 3 (secondary, muted) | **Provenance** (sources) · **Historique** (the latest saves, Task 19) |

**Suivi composition** (`TrackingTab.tsx`, `tracking-tab.css`): `ProspectEditor` renders one `<TrackingTab>`; the tab composes the
unchanged sections (`TrackingSection`, `SequenceSection`, `ProspectNotes`, `AlertsSection`, `ProvenanceSection`,
`HistorySection`) as the shared `EditorSection` cards in a two-column grid that stacks when the panel is narrower than 54 rem and gives
the cards of a row the same height. Long notes and histories scroll inside their card. No state, action or save
semantics changed; the former *Semaine / Relance / Référent / RDV* summary inside *Suivi de contact* moved to the band
(the level stays in *Séquence de contact*).

The *Qualité de la fiche* numeric card (`DataQualityCard`) and the standalone `ProximityScoreCard` were removed at S7: the
fiche is shown as a named state and the proximity as a score in the indicator strip, both live (`indicatorSources.ts`).

The footer is the dirty-state bar (status, *Supprimer*, *Annuler les modifications*, *Enregistrer*, *Enregistrer et fermer*, queue position and arrows).

**Employment verification** has no card of its own (D-UX3): it is the secondary line of **Emploi** — a state badge
(*Valeurs importées, jamais vérifiées*, *Vérifié le …*, …) and its actions (*Vérifié aujourd'hui*, *Effacer la
vérification*, *Annuler*; the *ou vérifié le* date is an input of the edit mode), a `group` named *Vérification de
l'emploi*. Data (`employment_verified_at`, `verification_state`, the `employment_verification` action of the `PUT`) and
`verification.ts` are unchanged; the Prospection list and the Prospection KPIs still read the same field.

### Tabs

- Both panels stay mounted, the inactive one `hidden`: every field, the open sections and a half-typed note survive a tab
  change, and the tabs only move the view (no data is read or written by switching).
- **Remembered tab**: Profil whenever another prospect (or a fresh form) is shown — Save & Next, Back/Forward, a new
  person — and kept while the same prospect is saved. The choice is not stored anywhere (no preference to unlearn).
- **An inactive tab never hides a problem**: a mark in its name — a dot with the hidden text *modifications non
  enregistrées* for pending changes (`dirtyTabs`: the draft compared per tab as a payload), a warning glyph with *champs à
  corriger* for fields refused by the form or the server. A save refused for a field of the other tab switches to that
  tab, opens its section as inputs and puts the focus on the field (`reveal` in `ProspectEditor.tsx`).
- Field → tab and section mapping, pure and tested: `profileEditing.ts` (Suivi holds `tracking.*` and
  `provenance.*`; everything else is Profil).

### Read / edit sections (Profil)

**Identité**, **E-mails**, **Téléphones** and **Emploi** read as compact facts (or, for aliases, one line per address or
number: value, type, *Principal*, status badge) and show their inputs only while they are *being edited*. This is a
second **view** of the same `draft`, never a second state: the summary and the facts follow what is typed, `isDirty`,
the validations and the payload are unchanged, and the footer says *Modifications non enregistrées* whichever view shows.

| Gesture | Effect |
|---|---|
| *Modifier* (button *Modifier : Identité*…) | The section shows its inputs; the focus goes to its first field. |
| *Terminer* | Back to the facts; the changes stay in the draft (pending). Absent while a field of the section is invalid. |
| Save succeeded | Every section reads as facts again (the focus stays where it was). |
| *Annuler les modifications* | Draft back to the saved state; sections back to their initial view. |
| Opens invalid / invalid after a save / refused by the server | The section with the error is shown as inputs, cannot be closed until fixed, and its tab is brought forward. An imported person without company opens with **Emploi** as inputs. |
| New prospect | Every section is inputs, no *Modifier* switch, no summary. |

Tracking, provenance (new person) and the opposition are not behind a switch: the Suivi tab is the working tab of the
contact workflow, so its fields are always inputs. The one-click actions (*Vérifié aujourd'hui* of the employment) work
from the summary without opening the section; the alias *Vérifié* button and the actions menu are inputs of the edit mode.

## Field semantics

| Section | Field | Stored in | Rules |
|---|---|---|---|
| Identité | Civilité | `civility` | `M.` / `Mme` / none. |
| | Prénom, Nom | `first_name`, `last_name` | Trimmed, inner spaces collapsed, 100 characters; at least one of them (*Saisissez au moins un prénom ou un nom.*). The typed casing is kept (unlike the import's re-casing). |
| Emploi | Entreprise * | `company_id` | Required to save (server too). Server-side search over **every** company by name; *Créer l'entreprise « … »* opens the Company editor prefilled with the text (its similar-companies warning still applies); the saved company is selected. Changing it applies the company-change rule (below). |
| | Rôle | `role_id` | The normalized classification used by filters. *Créer le rôle « … »* creates the role **with the save** (same rules and `role.created` audit as Paramètres; a cancelled edit creates nothing; an existing label, even deactivated, is refused). |
| | Intitulé exact | `exact_job_title` | The person's own wording, 255 characters. |
| | Activité | `activity_status` | *Actif / Inactif / Inconnue* — in post, left, or not determined. Independent of the opposition and of verification. A new person starts at *Inconnue* (nothing is assumed). |
| Emploi (ligne secondaire) | *Vérifié aujourd'hui*, *ou vérifié le* (date), *Effacer la vérification* | `employment_verified_at` | Covers company, role, exact title and activity. Explicit only: see *Verification*. |
| E-mails, Téléphones | repeaters | `emails`, `phones` | See *E-mails and phones*. |
| Opposition | *Enregistrer une opposition…*, *Lever l'opposition…* | `contactability_status`, `do_not_contact_at`, `do_not_contact_reason` | Dedicated operation, never the save — see *Opposition*. |
| Suivi de contact | État | `contact_tracking.status` (commercial states, data-model) | **Backend since the sequences rework (S1, decision log R-04)**: five states — `neutral` (*En séquence*, no badge), `response_received`, `appointment_obtained`, `ignored`, `disqualified` (*Défaillant*, a person only); `contacted`, `r1`, `r2`, `failure` are refused (422). The form still shows the former eight states and the week planner until the S4 UI: choosing a former state answers 422. A saved *Ignoré* disables the select and the opposition cannot be lifted. *Depuis le …* = the last status-history entry not written by a migration. A tracking is never deleted from the editor. |
| | Prochaine action (UI until S4) | — | **No stored next action any more** (R-01): the cohort, the level and the next due date are derived and returned as `contact` (see below); the week planner of the form is ignored by the save (`tracking.planned_contact_on` accepted and dropped) and `PATCH …/tracking` refuses `next_action_week` (422 `derived`). The S4 UI replaces the planner by the cohort, the level, « Marquer comme envoyé » and the alerts ([`contact.md`](contact.md)). |
| | Réponse reçue le | `response_received_at` | A day. |
| | Rendez-vous le … à … | `appointment_at` | A day and an optional time. |
| | Référent Circoe | `referent_id` | A Circoe internal referent (never a login). Emphasized (warning box + hint) once an appointment exists without one. Inline creation *Prénom Nom* through Paramètres, as everywhere. |
| Entreprise | summary | — | Name, legal name, SIREN, segment, city, e-mail domain, website, prospect count; every change goes through the Company editor (no company field is duplicated here). |
| Provenance | sources | `prospect_sources` | Each source: type, reference (file / sheet / row for imports), collection date, who recorded it (the history's actor badge: *Vous*, a person, *Import « fichier »*, *Système*, *Agent*), legal basis or collection context (or *non renseigné*); creation and last-change dates. |
| Historique | timeline | `audit_log` (read) | See *History*. Existing prospects only. |

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
| Imported values never verified | The Emploi section gets a warning edge and its secondary line the badge *Valeurs importées, jamais vérifiées*; Entreprise, Rôle, Intitulé exact get a warning outline and the text *Importé, à confirmer* (*Nouvelle entreprise, à confirmer* after a company change); the Activité choice a warning outline. Aliases: warning edge + *Importé, jamais vérifié*. Sections show counts (*1 à vérifier*). |
| Verified | Subtle success badge with the date (*Vérifié le 3 sept. 2026*) — the mint success colour, not the brand green. |
| Stale | Only when the threshold is configured: *Vérifié le … · ancien* (warning, clock glyph), for the employment and the aliases. |
| Missing | Actionable empty states: *Aucune adresse. Ajoutez…*, *Aucune entreprise choisie*, *Pas encore vérifié*; a new form starts with one empty e-mail and phone line. An imported person's **empty** Rôle, Intitulé exact or Entreprise says what to do (*Aucun rôle — choisissez-en un ou créez-le.*, *Aucun intitulé — saisissez le libellé de poste de la personne.*, *Aucune entreprise — choisissez-la ou créez-la.*) rather than *Importé, à confirmer* (nothing to confirm, I-136). |
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

Independent of the activity and of the contact stage (*Failure* is an outcome, not an opposition; *Ignoré* reinforces it and keeps it). *Enregistrer
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
  the focus (its tab and section are shown first); validation runs in the browser first with the same rules.
- **Enregistrer et suivant** saves when there are changes (otherwise just moves on), then asks the Prospection queue for
  the next person (`ProspectQueue.next`: the list order when the editor opened, read again after a save so a person
  leaving the segment never makes it skip anyone) and opens them in place; at the end of the list the editor stays and
  says so. After every write, `prospectionKeys.all` (counters and pages), companies and Settings caches refresh.
- **Conflicts**: every write sends the version read with the prospect; if the prospect, one of its aliases or its
  tracking changed meanwhile (another tab, the Database Explorer), the save is refused (409) — *Ce prospect a été modifié
  ailleurs depuis son ouverture.* with *Recharger la fiche* — instead of overwriting.
- **Keyboard**: the tabs follow the WAI-ARIA pattern (one tab stop; ←/→ move and select with wrap, Home/End); logical
  tab order inside a panel (left column, then right); on open the focus goes to the first field, or to the first *Modifier*
  when the identity reads as facts; **Ctrl+S / ⌘S** saves, **Ctrl+Entrée** saves and moves
  on (*Enregistrer et nouveau* for a new person), **Enter** in a one-line field saves (like the Company editor; an open
  picker uses Enter to choose), **Échap** closes — asking first when changes are pending (*Abandonner les
  modifications ?*). Shortcuts act only in the editor, not in a dialog above it.

## New prospect

`?prospect=new`: empty form, activity *Inconnue*, one empty e-mail and phone line, and the **provenance** fields —
*Contexte de collecte ou base légale* * (default « Saisie manuelle — prospection B2B », editable) and *Où avez-vous trouvé
ce contact ?* (optional). The save records a `manual` source collected now by the signed-in user. *Enregistrer* keeps the
drawer on the created person; *Enregistrer et nouveau* opens a fresh form keeping the company and the provenance texts
(entering several people of one company). The opposition waits for the first save. Every section is inputs (no summary, no *Modifier*), the first name is
focused, and the provenance fields are on the **Suivi** tab (a refused one switches to it).

## Deletion

*Supprimer* opens a confirmation listing what goes with the person (*1 téléphone, le suivi de contact et son historique,
1 trace de provenance, 1 ligne d'import d'origine*); the company stays. An **opposed** person cannot be deleted
(*Suppression impossible* explains why: a later import could recreate them as contactable — lift the opposition first,
with its reason). One `prospect.deleted` event; the cascaded rows are not audited one by one (ADR-0006 limit).

## History (Task 19)

The *Historique* section (below *Provenance*) lists who changed what and when, one entry per save, the latest first:
10 entries, then *Voir plus* for older ones. Built by the backend history formatter
([audit-and-provenance.md](../architecture/audit-and-provenance.md#visible-history-task-19)); it covers the person and
their e-mails, phones, contact tracking and sources.

- Each entry: the actor badge (*Vous* for the signed-in user, another person's name, *Import « base.xlsx »* with
  *confirmé par …*, *Système* with the command, *Agent*), the source (*Interface*, *Import*, *Base de données*, *Ligne de
  commande*, *Agent*), a relative and an absolute date (*il y a 5 minutes · 11 sept. 2026 à 10:32*), a title (*Fiche
  créée*, *Fiche modifiée*, *Changement d’entreprise*, *Opposition enregistrée*…) and change lines: *E-mail principal :
  ancienne@… → nouvelle@…*, *Entreprise : A → B*, *Opposition enregistrée — motif : …*, *Étape : Contacté → Relance 1*,
  *E-mail jean@… · vérification : Non vérifié → Vérifié*. A creation lists its fields; beyond 5 lines, *Afficher les N
  autres*.
- Values are shown as the audit stored them (full in V1, masked if the policy is tightened); never raw JSON, never a
  secret. Readable, not a compliance log: no rollback, no filter.
- The section refreshes after every save and opposition change of the editor.
- A save sends a stored alias's source reference back unchanged, so it never rewrites an import reference (I-137).

## API — `/api/prospects` (session + CSRF, `api_router`)

| Method & path | Body / query | Answer |
|---|---|---|
| `GET /prospects/{id}` | — | The view model: identity, `company` summary, `role`, employment and `verification_state`, `employment_imported_unverified`, contactability, `emails` / `phones` (primary first, each with `imported_unverified`), `tracking` (days in business time, `appointment_time`, `referent`, `status_since`), `contact` (derived, R-01: `cohort`, `sequence_open`, `sent_count`, `level_label`, `next_step`, `finished`, `next_due_on`, `next_due_week`, `pause_reason`, `email_error`, `max_follow_ups`), `sources` (oldest first, with the import file name and `recorded_by` — a history actor), `import_row_count`, `today`, `stale_threshold_days`, **`score`** (backend-computed `ProspectScore`), timestamps, **`version`** |
| `GET/POST /prospects/{id}/notes`, `PATCH/DELETE …/notes/{note_id}` | see [Notes and score](#notes-and-score) | |
| `GET /prospects/{id}/history` | `limit` 1–50 (10), `before` (a `next_cursor`) | `{items: [{id, occurred_at, actor: {kind, label, id, on_behalf_of}, source, actions, title, summary, changes: [{label, before, after}]}], next_cursor}` (Task 19) |
| `POST /prospects` | the form + `provenance: {legal_basis_or_collection_context, source_reference}` | 201 view |
| `PUT /prospects/{id}` | `version` + the whole editable state; `emails` and `phones` required (full lists) | view |
| `PUT /prospects/{id}/contactability` | `{do_not_contact, reason, version}` | view |
| `PATCH /prospects/{id}/tracking` | `{version, status}` — the commercial state chosen by a person (« Défaillant » included). `next_action_week` is refused (422 `invalid`, reason `derived`): the next due date follows the cohort and the real sends. | view + `cancelled_messages`: the unsent Contact messages cancelled by `response_received`, `appointment_obtained`, `ignored` or `disqualified` ([`contact.md`](contact.md)) |
| `DELETE /prospects/{id}?version=…` | — | 204 |

Form fields: `civility`, `first_name`, `last_name`, `company_id`, `role_id` or `role_label` (new role), `exact_job_title`,
`activity_status`, `employment_verification: {action: keep|verified_now|verified_on|clear, day}`, `emails: [{id?,
address, is_primary, is_active, verification_status, verified_now, source_reference}]`, `phones: [{…, number, type}]`,
`tracking: {status, response_received_on, appointment_on, appointment_time, referent_id} | null` (a former client's `planned_contact_on` is accepted and ignored until S4)
(null leaves the tracking as it is). Unknown fields are refused (422).

Refusals (`app/api/errors.py`, French copy in `frontend/src/prospects/messages.ts`):

| Status | `detail` | Example |
|---|---|---|
| 422 | `{code: "invalid", field, reason}` — `field` e.g. `last_name` (`blank`), `company_id` (`blank`, `unknown`), `role_id` (`unknown`), `role_label` (`length`, `both`), `employment_verification.day` (`blank`, `future`), `emails.N.address` / `phones.N.number` (`blank`, `format`, `repeated`), `emails.N.is_primary` (`multiple`, `inactive`), `emails.N.verification_status` (`verification_action`), `emails.N.id` (`unknown`), `phones.N.type` (`blank`), `emails` (`exchange`: two lines swapping values), `tracking.referent_id` (`unknown`), `tracking.appointment_time` (`without_day`), `provenance.legal_basis_or_collection_context` (`blank`), `reason` (`blank`) | *Adresse e-mail invalide (ex. prenom.nom@exemple.fr).* |
| 409 | `{code: "duplicate", field: "role_label", existing}` | *Le rôle « Dirigeant » existe déjà : choisissez-le dans la liste.* |
| 409 | `{code: "conflict"}` | *Ce prospect a été modifié ailleurs depuis son ouverture…* |
| 409 | `{code: "do_not_contact"}` (delete) | *Suppression impossible : ce prospect est en opposition…* |
| 409 | `{code: "ignored_is_terminal"}` (a state change or lifting the opposition of an `ignored` prospect) | *Ce prospect est « Ignoré » : c'est définitif, son état ne change plus et son opposition reste enregistrée.* |
| 403 | `{code: "human_actor_required"}` | *Seule une personne connectée peut changer l'état de contact ou sa semaine (pas un agent).* |
| 422 | `{code: "invalid", field: "next_action_week", reason: "derived"}` (the next due date is never written) · `{code: "invalid", field: "status", reason: "empty"}` (PATCH without a state) | *La prochaine échéance se calcule depuis la cohorte et les envois réels.* · *Rien à enregistrer : choisissez un état.* |
| 404 | `{code: "not_found"}` | *Ce prospect n'existe plus…* |

## Notes and score

*Backend delivered by prospect-contact-ux S1; the notes UI by S2 and the score card by S4 (below).*

**Notes** (`prospect_notes`, [data model](../architecture/data-model.md#prospect_notes-migration-0014-prospect-contact-ux-s1))
are short facts: `fact_text` (required, trimmed, ≤ 1000), `noted_on` (optional day), `source_type` (optional) and
`source_label`, `score_delta` (optional integer `-50..50`). They live **outside the editor's `version`**: a note write
never makes an open editor stale and needs no `version`.

| Method & path | Body | Answer |
|---|---|---|
| `GET /prospects/{id}/notes` | - | `[note]` newest observed first (`noted_on` desc, undated last, then `created_at`) |
| `POST /prospects/{id}/notes` | `{fact_text, noted_on?, source_type?, source_label?, score_delta?}` | 201 note |
| `PATCH /prospects/{id}/notes/{note_id}` | any of the fields: omitted = kept, `null` = cleared (not for `fact_text`) | note |
| `DELETE /prospects/{id}/notes/{note_id}` | - | 204 |

A note: `{id, prospect_id, fact_text, noted_on, source_type, source_label, score_delta, created_at, updated_at}`.
Refusals: 404 `not_found` (prospect, or a note of another prospect); 422 `invalid` with `field` `fact_text`
(`blank`, `length`) or `source_label` (`length`); a `score_delta` outside `-50..50`, an unknown `source_type` or an
unknown field is a plain 422 validation error. Writes are audited (`prospect_note.created|updated|deleted`, shown in
the prospect's history as « Note ... ») and logged at info with ids only.

**Notes UI** (`ProspectNotes.tsx`, prospect-contact-ux S2). The *Notes* section sits in the *Suivi* tab, left column, under *Suivi
de contact*. It is **not part of the form**: notes are read and written through their
own API (`api/prospectNotes.ts`: `useProspectNotes`, `useNoteMutations`), immediately, so they never make the editor dirty,
never change its `version`, and are not touched by *Enregistrer* / *Enregistrer et suivant*. A write refreshes the notes,
the prospect's history and the prospect's cached view (its `score`). A prospect not saved yet shows *Possible une fois le
prospect enregistré.*

- **List**: one dense row per fact, in the API's order. The fact is the dominant text (wraps, never overflows); under it,
  in muted small text, the date (*Sans date* when none), the source type and its label; a discreet delta badge `+5` /
  `-10` / `0` (the sign is the text; the accessible name is *Impact sur le score : +5*); the overflow button (*Actions :
  …*, `ui/Menu`: *Modifier*, *Supprimer*) is visible on hover and on keyboard focus (always on touch). The list is
  bounded (22 rem) and scrolls inside the section (focusable, *Liste des notes*); the section title carries the count.
  Zero notes: one muted line, *Aucune note pour l'instant.*
- **Quick add**: *Nouveau fait* + *Ajouter*; **Entrée adds the note** (it never reaches the editor's form: no save, no
  *suivant*); **Ctrl/⌘+Entrée with a typed fact also adds the note** (so a typed fact cannot be dropped by the
  *Enregistrer et suivant* shortcut), with an empty fact it keeps its editor meaning. The date defaults to the prospect's
  business day (`today`) and can be changed or cleared; *Impact sur le score…* unfolds an optional integer `-50..50`.
  After a successful add the field is cleared and refocused, the date goes back to today and the impact is folded away.
- **Edit in place** (*Modifier*): the row becomes a small form (fact, date, impact, source type, source label); Entrée
  or *Enregistrer la note* saves (PATCH with all five fields, empty optional ones as `null` = cleared), Échap or
  *Annuler* cancels the edit only (the drawer stays open).
- **Delete**: a confirmation dialog (*Supprimer cette note ?*, the note quoted, its impact named, *Retour* focused
  first); on failure the dialog stays open with the reason.
- **Errors**: client checks first (*Saisissez le fait.*, *1000 caractères au plus.*, impact outside `-50..50`); then the
  server's refusal worded in French (`noteForm.noteRefusalMessage`: blank / length / range / not found), else *L'opération
  sur la note a échoué…*; shown inline (`role="alert"`) with what was typed kept and the buttons released. A list that
  cannot be loaded shows *Les notes n'ont pas pu être chargées.* with *Réessayer*. (The repo has no client-side error
  logging channel yet: the failures are visible on screen only.)

**Score**: `GET /prospects/{id}` carries `score: ProspectScore`, **computed by the backend** on every read (never
stored, never computed by the UI; decision D-UX2). Contract (`app/services/prospect_score.py`):

```
ProspectScore { total: 0..100, summary: str, band: "red"|"yellow"|"green",
                contributions: [{ id, delta, reason, source_type?, source_ref?, created_at?, origin: "manual" }] }
```

- A note with a `score_delta` is one contribution: `delta` = the delta, `reason` = the fact, `source_type = "note"`,
  `source_ref` = the note id, `id = "note:<note id>"`, `origin = "manual"`. A note without delta contributes nothing.
  `source_type`/`source_ref` are optional in the contract (a future automatic signal may have no note).
- `total = clamp(base + sum of deltas, 0, 100)`; a delta is shown as entered even when the clamp absorbs part of it.
- No contribution: `contributions = []`, `total = base`, summary « Aucun signal enregistré : score de départ. ».
  Otherwise the summary is a short factual sentence generated from the lines, e.g. « 3 signaux (2 favorables,
  1 défavorable), bilan +7. ». "Score absent" does not exist in the API: the view always has a score.
- Contributions are ordered newest observed first (same order as the notes).
- **Meaning (S4): commercial fit only.** Allowed inputs: the prospect's scored notes (manual, or `origin=agent` from
  a legacy accepted agent reassessment, shown with `origin = "agent"`) and its company's valid scored signals
  (capped), then **the latest AI assessment** (below).
  Forbidden: relationship graph / proximity, fiche completeness, Contact state (`ALLOWED_INPUTS` /
  `FORBIDDEN_INPUTS`, guard test `test_prospect_score_inputs.py`).
- **Évaluer / Réévaluer le score** (card button, 2026-11-18: the user switched scoring to a **direct LLM call**; the
  external-agent mission flow hung 15 minutes in production because no agent consumes the queue):
  `POST /api/prospects/{id}/score/evaluate` runs `prospect_scoring.score_prospect` synchronously (seconds) and answers
  the new `ProspectScore`. The backend gives the model the prospect sheet (identity, role, employment, e-mails and phones
  with their verification, company data and signals, notes, tracking state, sources) plus the Circoe target, never the
  graph / proximity nor the Contact state, and asks a strict JSON `{score 0-100, rationale, criteria[{label, delta,
  evidence}]}` (same OpenAI client, key, model, timeouts and typed `ai_*` errors as the Contact drafting). The answer is
  validated (wrong type, missing or extra key: refused; out-of-range score and deltas: clamped). Each success stores one
  immutable `prospect_score_assessments` row (migration 0058: score, rationale, criteria, model that answered, prompt
  hash, actor, duration). **The displayed score is the latest assessment's score**; with none, the note-based formula
  above is the fallback. `ProspectScore.assessment` (`rationale`, `criteria`, `model`, `prompt_version` = first 8
  characters of the instructions' SHA-256, `created_at`, `actor_display`) says where the figure comes from; the notes'
  `contributions` stay listed. A failure (not configured -> message pointing to Config AI, timeout, refusal, malformed
  answer, provider error) writes nothing and leaves the current score untouched.
- **Card states** (`ScoreEvaluation.tsx`, in place at the card's fixed 88 px body, no layout shift, light motion that
  stops under `prefers-reduced-motion`): idle, *Non évalué*, in progress (animated ring, « Évaluation en cours »,
  live seconds counter, abandoned after 2 minutes), success (the ring eases to the new value, « Score mis à jour » and
  the one-line rationale for 8 s; « Voir le détail » shows the criteria, the model, the prompt version, who and when),
  failure (« Échec · score inchangé », one line with the real reason, « Réessayer »). The progress is shared by every
  entry point (card, Mission menu, « … » / right-click menu) through one mutation key per prospect.
- **Config AI › Scoring prospect** edits the system prompt (`prospect_scoring_prompt`, default shipped, « Rétablir ») and
  the Circoe target (`circoe_target`, default shipped); the key and the model are those of Connexions. « Tester sur un
  prospect » (`POST /api/settings/integrations/scoring/test`) runs the saved texts on the most recently updated prospect
  and stores nothing. The answer format and the « fit only » rule are fixed by the code (`FIXED_RULES`).

**Qualité de la fiche = completeness state** (slice S2 of `viper_prospect_sheet_missions_scoring_redesign`; no longer a
displayed score). `GET /prospects/{id}` carries `data_quality: DataQualityScore | null` (the field name is kept for
compatibility), computed on read by `app/services/prospect_data_quality.py`, deterministic (no LLM), never stored. It
says how reachable and trustworthy the record is, and is independent of the commercial-fit `score`.

Product contract (`ProfileCompleteness`, `frontend/src/api/profileCompleteness.ts`):

```
{ state: "incomplete"|"usable"|"rich"|"very_rich",
  state_label: "Incomplète"|"Exploitable"|"Fournie"|"Très fournie",
  state_description: str,            // what the state means (tooltip)
  summary: str,                      // « À compléter : … » or « Fiche complète et vérifiée. »
  criteria: [{ id, label, status: "met"|"partial"|"missing", detail }] }
```

`data_quality` is `null` for a prospect under durable opposition (`do_not_contact`): the card says « Écarté ». The card
shows the state badge, an info tooltip with its meaning, a decorative 4-step meter, the summary, and a *Voir les
critères* disclosure split into « à compléter » and « acquis ». An unavailable value is stated (`unavailable` prop), not hidden.

Implementation detail (not product vocabulary, never displayed): the state is derived from a private 0..100 point total
over 9 criteria — active e-mail 20, verified e-mail 20 (primary one, else any active; `invalid` never counts), active
phone 10, verified phone 5, employment verified 15 (8 when older than `VIPER_VERIFICATION_STALE_DAYS`), known activity 5,
company 10, role 10, exact job title 5. Thresholds on that total: `VIPER_PROSPECT_COMPLETENESS_USABLE_FROM` (default **50**),
`..._RICH_FROM` (**75**), `..._VERY_RICH_FROM` (**90**), strictly increasing; to be confirmed by the product. One gate: no
active e-mail and no active phone = `incomplete` whatever the points. `status` is `met` at full points, `partial` for
some, `missing` for none (the stale employment is `partial`).

Deprecated compatibility adapter: the payload still carries `total`, `band` (`VIPER_PROSPECT_DATA_SCORE_RED_BELOW` **50** /
`..._GREEN_FROM` **80**) and per-criterion `points`/`max_points`, because the prospects dashboard « Fiabilité » (SQL
twin `quality_sql`) still uses the numeric total. Remove them with the dashboard dependency (follow-up, not done in S2).
UI: `completenessView.ts` (tones, criterion split) feeding the *État de la fiche* cell of the indicator strip (S7 wiring; the
former `DataQualityCard` and its CSS are gone).

**Configuration** (environment, `core/config.py`; the contract does not contain these numbers):
`VIPER_PROSPECT_SCORE_BASE` (default **50**), `VIPER_PROSPECT_SCORE_RED_BELOW` (**40**) and
`VIPER_PROSPECT_SCORE_GREEN_FROM` (**70**): red below 40, yellow from 40 to 69, green from 70; red-below must be lower
than green-from. These defaults come from the orchestrator (D-UX2) and are **to be confirmed by the product**. Not
editable in Paramètres.

**Score card UI** (`ProspectScoreCard.tsx`, `scoreView.ts`, `prospect-score.css`, primitive `ui/ScoreRing`;
prospect-contact-ux S4). Top of the Profil tab's right column, above *Emploi*; a prospect not saved yet has no card
(the slot stays and takes no room). The score read is the prospect's own query (`useProspect`), which every note write
invalidates (`useNoteMutations`): the card follows a note added, edited or deleted without saving the prospect; if that
refresh fails the last figure stays with *Mise à jour impossible : ce score peut être périmé.*

- **Card**: one button (`aria-haspopup="dialog"`, name *Score prospect : 50 sur 100, niveau moyen. Voir le détail*, the
  summary as its description) holding the ring (0-100), the band **word** (*Faible* red / *Moyen* yellow / *Élevé*
  green), the summary (cut after three lines, whole as the tooltip and in the detail) and the *Voir le détail ›*
  affordance. The band is `score.band` as sent: the front knows **no threshold**; colour (token `danger-fg` /
  `warning-fg` / `success-fg`) only reinforces the word and the figure.
- **Detail** (*Détail du score*): a `Modal` `lg`, not a `Popover`: the list can be long, the contributions hold actions,
  and the focus must be trapped (the Popover is non-modal and not trapped). It opens on click, Entrée or Espace; Échap
  (or *Fermer*, or the backdrop) closes **only the detail** (the `Modal` stops the key: the drawer stays open and the
  unsaved-changes confirmation does not appear) and the focus returns to the card. It shows the ring, *N sur 100 · niveau
  …*, the summary, then the contributions.
- **Contribution order** (`sortContributions`): positives and zeros by decreasing delta, then negatives from the most
  damaging (lowest delta); equal deltas keep the API order. Each line: the signed delta as text (*+25*, *-10*; accessible
  name *+25 points*), the reason (wraps, never cut), the source in words (*Note du prospect*, *Source : …*, *Source non
  précisée*). No contribution: *Aucun signal enregistré : le score est à sa valeur de départ.* (also the case of a score
  sent without breakdown).
- **Voir la note** (only when `source_type === "note"` and `source_ref` is set): closes the detail, switches to the
  *Suivi* tab (`ProspectEditor` `noteToShow`) and `ProspectNotes` (`showNoteId` / `onNoteShown`) scrolls the row into
  view, focuses it and marks it `data-highlight` (focus-ring outline + soft accent background) until it loses focus. A
  note that no longer exists just drops the request.

**AI mail context** (handoff Task 05, prompt `contact-mail-fr-2026-10-v3`): the notes and the score (same service, no
second computation) enter the drafting context; since v3 a score with no contribution is left out and a contribution that comes from a listed note points to it (« voir fait n°2 ») instead of repeating its text; rules and limits in [`contact.md`](contact.md) § AI drafting.

**Open points**: product-confirmed base/thresholds; the `NoteSourceType` vocabulary; automatic contributions (other `origin`s) are out of scope.

## Audit

Every write is attributed to the signed-in user (`source=ui`, one `request_id` per save), one event per changed row:
`role.created` (inline role), `prospect.company_changed` (both company names, `employment_verified_at` cleared, each reset
alias its own `email/phone.updated`), `prospect.updated` (identity/employment fields; a role change carries both role
labels), `email/phone.created/updated/deleted`, `contact_tracking.created/status_changed/updated` (+ status history),
`prospect_source.created` (creation), `prospect_note.created/updated/deleted`, `prospect.do_not_contact.set/cleared` (`context.reason`), `prospect.deleted`. A save
that changes nothing writes nothing.

## Code

| Layer | Where |
|---|---|
| Services | `backend/app/services/prospect_notes.py` (notes CRUD), `backend/app/services/prospect_score.py` (score contract and rules), `backend/app/services/prospect_editor.py` (view model, `create_prospect`, `update_prospect`, `set_contactability`, `delete_prospect`, `aggregate_version`), `backend/app/services/contact_channels.py` (alias normalization and full-list save), existing domain operations in `prospects.py`, `contact_tracking.py`, `provenance.py`, `taxonomies.py` |
| Repositories | `backend/app/repositories/notes.py`, `backend/app/repositories/prospects.py` (`lock_prospect`, `version_rows`, `sources_with_batches`, `count_import_rows`), `companies.company_summary`; `prospection.query.prospect_verification_state` |
| Router | `backend/app/api/routes/prospects.py` |
| Frontend | `frontend/src/prospects/` (`ProspectEditor`, `EmploymentSections`, `AliasList`, `TrackingSection`, `WeekPlanner` (+ `week-planner.css`), `OppositionSection`, `ProspectNotes` (+ `prospect-notes.css`, `noteForm.ts`), `ContextSections`, `pickers`, `EditorSection` (read/edit switch), `ProfileSummary` (summary + `useEmploymentLabels`, `profile-summary.css`), `ProfileLayout` (rows, `profile-layout.css`), `ProspectIndicatorStrip` (+ `indicators.ts`, `indicatorSources.ts`, `indicator-strip.css`), `ProspectScoreCard` (+ `scoreView.ts`, `prospect-score.css`), `ui/ScoreRing`, `profileEditing.ts` (field → tab / section, per-tab dirty), `prospectForm.ts`, `verification.ts`, `messages.ts`, `prospects.css`), API hooks `frontend/src/api/prospects.ts` and `frontend/src/api/prospectNotes.ts`; history: `frontend/src/history/` (`HistoryTimeline`, `format.ts`), `frontend/src/api/history.ts`, backend `app/services/history.py` |

## Tests

- Backend notes and score: `tests/test_prospect_score.py` (contract, clamp, bands, config), `tests/test_prospect_notes_api.py` (CRUD, refusals, score in the view, cascade), `tests/test_schema_constraints.py` (CHECKs, cascade).
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
- Frontend notes (S2): `src/prospects/ProspectNotes.test.tsx` (0 / 1 / many notes, long text, with and without date, delta
  +/-/0, add by Enter / Ctrl+Entrée / button, validation, server refusal, edit, Échap, delete and its failure, keyboard
  access to the row actions, list load error), `noteForm.test.ts`; e2e `prospect-editor.spec.ts` (*notes:*).
- Frontend score (S4): `src/prospects/ProspectScoreCard.test.tsx` (scores 0 / 1 / 50 / 99 / 100 with their bands, band
  from the API and no threshold, long summary, no score, outdated, open by click / Entrée / Espace, Échap and focus
  return, focus trap, empty breakdown, order and signs, long reason, *Voir la note*), `ProspectScore.test.tsx` (in the
  editor: follows a note added / deleted, no card for a new prospect, Échap leaves the drawer and its confirmation alone,
  *Voir la note* brings the note into focus), `scoreView.test.ts`, `ui/ScoreRing.test.tsx`; e2e
  `prospect-editor.spec.ts` (*score:*, screenshots dark/light 1440 / 1280) and the axe case *détail du score*.
- Frontend profile and tabs (S3): `src/prospects/ProspectProfile.test.tsx` (complete profile, e-mail / phone missing, other
  addresses and inactive ones, long name / role / company, verification as a secondary line without a card, the score card in its
  slot, read → edit → save → read, *Terminer*, invalid prospect opening as inputs, new prospect all inputs, tabs by keyboard,
  mark on an inactive tab with changes, refused field of the other tab brought into view, two tabs in error),
  `profileEditing.test.ts`; helpers `src/test/prospectEditorUi.ts` (`editorReady`, `showTab`, `editSection`). The older
  editor tests open the tab or the section they work on first.
- Frontend: `src/prospects/prospectForm.test.ts`, `verification.test.ts` (pure rules and labels);
  `ProspectEditor.test.tsx` (prefilled sections, imported warning treatment and one-click verification, verified state,
  one-request save + list refresh, dirty bar / revert / guarded Esc, refusal on its field, conflict reload),
  `ProspectAliases.test.tsx` (add + make primary, deactivate/remove through the menu, phone type from the number, company
  change effect), `ProspectOpposition.test.tsx` (set/lift dialogs with reason, blocked and allowed deletion),
  `ProspectSaveNext.test.tsx` (Save & Next through a queue, Ctrl+Entrée without changes and the end of the list),
  `ProspectCreate.test.tsx` (creation with provenance and *Enregistrer et nouveau*, required fields, company created
  through the Company editor), `ProspectTracking.test.tsx` (role created with the save; week planned without a state → `neutral` on the Monday;
  another year through the selects and *Effacer*; cadence offered, applied only on click, hidden for another state;
  the eight states, echo week dropped on *RDV pris* and referent emphasis; *Ignoré* closing the planner, saved *Ignoré*
  locked with its opposition; French copy of `ignored_is_terminal`) — against `src/test/prospectsApi.ts` and `src/test/renderProspectEditor.tsx`. Task 19: empty imported
  fields' empty states, provenance badge and history section, history refreshed after a save (`ProspectEditor.test.tsx`),
  stored alias source sent back unchanged (`prospectForm.test.ts`), `src/history/*.test.ts(x)` (actor badges, sources,
  dates, change lines, *Voir plus*, folded creation, empty state); backend `tests/test_history.py`,
  `tests/test_history_api.py`; Playwright `e2e/history.spec.ts`.
- Playwright `e2e/prospect-editor.spec.ts` (real backend, its own imported people): open from the list, verify the
  employment, add a second e-mail made primary, plan a week (*+1 semaine*) and a state, Save & Next to the next person of the
  filtered queue; add a person with a company created inline; record an opposition and find it under *Opposition*;
  screenshots of the warning and verified states in both themes at 1440×900 and 1280×800 (plus the *Suivi de contact*
  section alone: `prospect-editor-<state>-tracking-<theme>-<width>.png`; the verified state is saved *Contacté* + 1 week,
  so the cadence proposal shows); since S3 the shots are Profil as a summary (`prospect-editor-<state>-<theme>-<width>.png`),
  Profil with its sections as inputs (`…-aliases-…`) and the Suivi tab; each checks that neither the page nor the drawer
  body scrolls horizontally, and a dedicated test imports a very long name, company, role and address and checks both tabs,
  summary and edit mode, at 1440 and 1280 px. `accessibility.spec.ts` scans the editor on Profil and on Suivi with every
  section in edit mode.

## Mission menu and Contacter (S5 components, mounted by the header at S7)

Mounted in `ProspectEditor` through the new `Dialog` `headerActions` slot (left of the close button), only for a saved prospect:
*Mission* (`ProspectMissionMenu`, role label from the employment labels) and *Contacter* (`ProspectContactButton`, disabled with
« Ne pas contacter : <raison> » as tooltip under opposition). The whole sheet sits in `ProspectContextMenuSurface`.
« Réanalyse son score » is not a mission: the menu calls `POST /api/prospects/{id}/score/evaluate` (direct AI call, the
popover follows the evaluation and the card shows the same progress); « Complète cette fiche », « Cherche ses relations » and « Autre » use the S5 mission factory.

- `<ProspectMissionMenu prospect={{ id, firstName, lastName, roleLabel?, companyId?, companyName? }} onCreated? />` goes in the
  header action slot; it creates prospect-targeted missions (see doc/architecture/missions.md §7g).
- `<ProspectContactButton prospectId disabledReason? />` is the explicit « Contacter » action. `<ProspectSheetMenu>` (wraps the
  sheet, wires `<ProspectContextMenuSurface actions>`) offers on right click, the context-menu key or Shift+F10 (arrows, Home/End,
  Enter, Esc; icons; links, buttons and fields keep the browser menu for the mouse): *Lier à…* (opens the Relations add form and
  focuses it), *Mission* (opens the header popover), *Contacter* (`/contact?prospect=<id>`), *Réévaluer le score* (the evaluation, outcome
  announced under the sheet), *Graph* (`prospectGraphHref`: `/prospection/graphe?prospect=<id>`, selected in the graph; asks before
  leaving with pending changes), *Société* (Company editor, disabled without a company). Each has a visible button: header (Mission,
  Contacter), Relations card (*Lier à*, *Graph*), Score card (*Réévaluer le score*), Entreprise card (*Ouvrir la fiche entreprise*).
- **Relations card**: dense rows in an auto-fill grid (initials avatar on the graph's hue, name + company/*Membre*, relation chip,
  strength meter + number); edit (relation + strength) and delete appear on hover/focus; *Lier à* toggles an inline add row; the empty
  state is one line; every failure (save, delete) shows an alert on the row.
