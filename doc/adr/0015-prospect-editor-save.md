# ADR-0015 — Prospect editor save: one composed transaction, explicit verification actions, aggregate version

- Status: accepted
- Date: 2026-09-11
- Deciders: Task 15 (Prospect editor), for orchestrator review
- Related: `doc/features/prospect-editor.md`, decision log I-100 … I-109, ADR-0002 (do-not-contact trigger, deletion
  rules), ADR-0006 (audit), ADR-0008 (explorer row versions), ADR-0014 (segments), I-13 (company-change rule), I-17
  (services flush, callers commit)

## Context

The Prospect editor saves, in one user action, what several domain operations own: the identity and employment fields,
a company change with its re-verification rule (I-13), e-mail and phone aliases with one primary each, the contact
tracking and its status history, a role the user creates inline, and for a new person its provenance. The task asks
for one atomic save, for employment and channel verification to stay separate and explicit, for the durable opposition
never to be cleared casually, and for a concurrent change never to be overwritten silently. Three questions need one
answer: how the save is composed, how the payload says "verified", and what "the version the user edited" is.

## Decision

1. **Composition in the caller's transaction.** `app/services/prospect_editor.py` locks the prospect, checks the
   version, validates, then calls in order: `taxonomies.create_value` (a role typed in the picker, `role_label`),
   `prospects.change_company`, the identity/employment assignment (one `prospect.updated` event with a readable role
   label), `contact_channels.save_channels` for e-mails then phones (full lists, two flushes around the partial unique
   indexes), `contact_tracking.save_contact_tracking`, and on creation `provenance.add_manual_source`. Services flush;
   the request's unit of work commits once (I-17), so any refusal — including a database one translated in a savepoint
   — rolls every step back.
2. **Verification is an action, not a state diff.** The employment verification travels as
   `{action: keep | verified_now | verified_on, day | clear}`; each alias carries `verified_now`. A `verified` status
   without that flag is accepted only for an alias that is already verified and unchanged *after* the company-change
   rule ran (else 422 `verification_action`); an edited value is new, never verified, `manual`. The editor mirrors these
   rules to show their effect before saving, but the server stays the judge.
3. **Contactability is not part of the save.** The payload refuses unknown fields; the opposition is set or lifted by
   `PUT /api/prospects/{id}/contactability` with a mandatory reason, through `mark_do_not_contact` /
   `clear_do_not_contact` (the only path the database trigger accepts for clearing).
4. **Aggregate optimistic version.** `version` = a SHA-256 fingerprint of `(kind, id, updated_at)` of the prospect and
   of its e-mails, phones and tracking, read with one `UNION ALL` without loading ORM collections. Every write sends it
   back; under the row lock a different current value answers 409 `conflict`. The contactability operation returns
   the new version, which the editor adopts while keeping its draft.

## Consequences

- One request = one audited save: every event carries the signed-in user, `source=ui` and one `request_id`, which
  Home's recent activity (Task 16) groups into one line; a save that changes nothing writes nothing.
- The payload cannot undo I-13 by echoing loaded statuses, and a same-day re-verification is never mistaken for "left
  as loaded". Clients must send `verified_now` / an employment action to verify — slightly more explicit than a plain
  status field.
- Any write path that touches the prospect, an alias or the tracking (explorer, another tab, an import merge) makes a
  pending editor save conflict, even when the edited fields do not overlap — safe, occasionally conservative (as
  ADR-0008). Within one database transaction `now()` does not move, so two writes of one test transaction share a
  version; real requests are separate transactions.
- A role created inline exists only if the save succeeds; the Company editor keeps its immediate creation of segments
  and categories (two behaviours, both documented).
- Deleting a prospect removes its children by database cascade; only `prospect.deleted` is audited (ADR-0006 limit).

## Alternatives considered

- **Several requests from the browser** (identity PUT, then aliases, then tracking) — each smaller, but a failure in
  the middle leaves a half-saved person and several audit groups; the task requires one atomic save.
- **Whole-state statuses diffed against the stored ones** — no new field, but ambiguous (see decision 2) and a client
  echoing the loaded state would silently re-verify channels after a company change.
- **`prospects.updated_at` as the version** (like the explorer's row version) — misses alias and tracking changes, which
  the full-list save would then overwrite.
- **A version column bumped by triggers on child tables** — exact, but a migration and triggers for what a read-time
  fingerprint gives with the existing `set_updated_at` triggers.
- **Contactability inside the save with a reason field** — one request fewer, but the durable opposition would ride
  along with ordinary edits; a separate, confirmed operation keeps it deliberate and independently audited.
