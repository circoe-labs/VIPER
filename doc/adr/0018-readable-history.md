# ADR-0018 — Readable history: one backend formatter, one entry per save, cursor pages

- Status: accepted
- Date: 2026-09-11
- Deciders: Task 19 (visible history and provenance), for orchestrator review
- Related: [ADR-0006](0006-audit-integration.md) (audit events, subjects, request ids), `doc/architecture/audit-and-provenance.md`
  (*Visible history*), decision log I-130 … I-136, I-27 (personal values in the audit), I-32 (the frontend owns the
  French copy of refusal codes), I-116 (Home's first recent-activity lines)

## Context

The audit log (Task 05) stores one event per changed row with a change set of raw column values, ids and ISO dates.
People must now read who changed what and when on a prospect or a company, and Home's recent activity must use the same
data — without a raw compliance log, without JSON in screens, and without leaking what the payload policy protects.
Several readers need the same wording (the editors' timelines, Home, later agents' reports), and one save writes
several events (the prospect, two e-mails, the tracking). Three questions: where the wording lives, what one displayed
entry is, and how a long history is paged.

## Decision

1. **One backend formatter** (`app/services/history.py`) turns events into typed display data: actor
   `{kind, label, id, on_behalf_of}`, source, actions, a French title, value-free `summary` phrases and `changes`
   `{label, before, after}` as display strings. French field labels, enum wording, business-time dates and reference
   labels live there, next to the change sets they interpret (the column names, the `before_label` snapshots, the
   payload policy markers). A catalogue test requires every audited column of a prospect's or company's rows to be
   labelled or deliberately hidden. The frontend only names actors (« Vous » is the signed-in user) and sources, and
   dates entries relatively.
2. **One entry per save**: consecutive events with the same subject, actor, source and request id (ADR-0006 binds one
   per HTTP request); events without a request id group when consecutive with the same actor and source and under 5 s
   apart. Within an entry, a primary flag moving from one row to another reads as one line.
3. **Cursor pages of entries**: `GET /api/{prospects|companies}/{id}/history?limit=&before=`; the server reads events
   in blocks until one more entry starts, so an entry is never split, and returns the id of the page's last event as
   `next_cursor` (order `occurred_at`, `id` — deterministic).
4. **Home shows `summary` only** (no values); the editors show `changes`. Values are displayed as stored: the audit
   payload policy already decided what is kept (I-27).

## Consequences

- Home, the Prospect editor and the Company editor read the same grouping and the same phrases; a wording change is one
  edit and its tests. The API is language-bound for this read-only display data (like the backend's French messages of
  I-66), unlike refusal codes (I-32), which stay codes because the frontend maps them onto fields.
- A new audited column shows nothing until it is labelled — the catalogue test fails first.
- Tightening `POLICY.personal_values` changes new entries only (stored values are shown as stored); older events keep
  their values until a redaction migration (open question #2).
- Reference labels are current labels unless the service snapshotted them in the event (company names on a company
  change, role and segment labels): a renamed role reads under its new name in older creation lines.
- Cost per page: one indexed read per 100 events, one query per referenced kind present, at most one identity query;
  Home adds no statement (its summaries need no lookup).

## Alternatives considered

- **Wording in the frontend from raw change sets** (Task 16's `activity.ts` approach) — the browser would receive raw
  JSON (ids, masked markers, legacy fields) and each screen would re-implement the same interpretation.
- **Entries = events** — one save would show four or five entries (« E-mail modifié », « E-mail ajouté »…) and a primary
  switch as two unrelated flags.
- **Offset pages of events** — a page could cut a save in two, and offsets drift while new events arrive.
- **Snapshotting identities in every audit event** (e.g. the e-mail address on each e-mail update) — exact labels
  without lookups, but a change of the audit core and of the payload policy for a display need; the formatter finds the
  identity in the row's earlier events instead (one query per page).
