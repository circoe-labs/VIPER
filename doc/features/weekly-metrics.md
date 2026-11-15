# Weekly metrics — « cette semaine » read-model

`GET /api/metrics/weekly` (`backend/app/api/routes/metrics.py`, service `app/services/weekly_metrics.py`, types
`frontend/src/api/metrics.ts`). Read-only, authenticated. Slice S1 of the Prospection / Contact / Home rearchitecture.
It reuses the existing predicates; it is not a second counter system ([home-dashboard.md](home-dashboard.md),
[prospection-kpis.md](prospection-kpis.md), [contact.md](contact.md)).

## « Cette semaine »

`app.core.business_time.BusinessWeek`: **Monday 00:00 inclusive to next Monday 00:00 exclusive, Europe/Paris**
(DST-aware, so 167 to 169 real hours). `today` is the Paris business day; `week_start` is the Monday, `week_end` the
Sunday (inclusive), `week` the ISO label (`2026-W43`). Home's `week_start` / `week_end`, Contact's `ContactClock` week
and Prospection's `SegmentContext.week_start` are the same week.

## Fields

| Field | Definition | Source of truth |
|---|---|---|
| `additions.prospects` / `companies` / `warehouses` | rows whose **`created_at`** is in the week (never `updated_at`); warehouses = sites, not their embedded contacts | `home.weekly_additions` (also feeds `/api/home/dashboard` `weekly_activity` and `new_*`) |
| `contact_stock.to_contact` | first contact planned, any date | segment `to_contact` |
| `contact_stock.to_send` / `overdue` | to send by end of this week (overdue included) / due before this Monday | `contact_dashboard.to_send` / `overdue` |
| `first_contact_to_send`, `follow_up_to_send`, `follow_up_overdue` | split of the above by next rank (0 / >= 1) | `next_rank_sql` |
| `contact_stock.upcoming` | sequence in progress, next send due after this week | `in_sequence` and not `to_send` |
| `contact_stock.contacted` | at least one real send | `contacted_sql` |
| `contact_stock.responses` | state « Réponse reçue » | tracking status |
| `contact_stock.appointments` | « RDV pris » or recorded appointment date | `has_appointment()` (= Home / Prospection `appointments`) |
| `contact_stock.mail_error` | open effective « Erreur sur le mail » (also Home `mail_inactive`) | `email_error_sql` |
| `contact_events.first_contacts` / `first_appointments` | first real send / first appointment recorded in the week, imports and migrations 0008/0012 restatements excluded | `home.weekly_recorded_firsts` |
| `contact_events.responses` | `response_received_at` in the week | tracking |
| `contact_events.mail_errors_opened` | prospects with an effective mail-error alert **created** in the week | `quality_alerts.created_at` |
| `contact_events.status_entries` | per state (`response_received`, `appointment_obtained`, `not_interested`, `ignored`, `disqualified`): prospects whose status history gained a row entering it in the week, restatements excluded | `contact_tracking_status_history` |

## Not truthfully computable

- **Weekly deltas of Prospection segments / activity status** (active, inactive, unknown, opposition, email_*…): no event
  history backs them; they would be differences of stock counts. `prospection_sub_status_deltas` is always `null`.
- The only Prospection sub-status weekly figure that has event data is the review boxes:
  `GET /api/prospection/counters` `reviews[x].week` (to_verify = created this week and still to verify; verified =
  became fully verified this week; ignored = entered « Ignoré » this week). It is not a net delta.
- `mail_inactive` has no figure distinct from `mail_error`.
- `status_entries` counts only history written since status history exists in VIPER; a response answered by import is
  not an event. `contact_events.responses` follows the current `response_received_at` (a cleared date drops out).
- Quotes / opportunities: out of scope (no contractual state).

## `GET /api/metrics/weekly-series?weeks=12` — week-by-week history (Home charts)

`weeks` 1 to 26 (default 12). Returns `weeks[]` oldest first, the current business week last; each point has `week`,
`week_start`, `week_end`, `additions {prospects, companies, warehouses}` (by `created_at`), `base {…}` (rows existing at
the end of the week: `created_at` before the next Monday), `first_contacts` (people contacted), `follow_ups` (people who
received a rank >= 1 message, recorded sends only), `appointments` and `ignored` (people whose status history gained
« Non intéressé » or « Ignoré », restatements excluded). `home.weekly_recorded_firsts_series` is the multi-week form of
`weekly_recorded_firsts`: imports and migrations 0008/0012 restatements are not events. `« Réponse reçue »` is not a
Home figure. `totals` is a stock as of now, not a sum of the weeks: `contacted` (`contacted_sql`), `with_appointment`
(contacted and `has_appointment()`), and an exclusive split of the whole base, first match wins: `base_appointment`
(`has_appointment()`), `base_ignored` (« Non intéressé » / « Ignoré », or in sequence and finished unanswered),
`base_contacted`, `base_not_contacted`.

- Conversion shown by Home: `with_appointment / contacted` (null when `contacted` = 0) and a pie of the four `base_*`.
- Limits: a week before any record is 0 because nothing was recorded, not because nothing happened; prospects contacted
  or answered before VIPER recorded events (imports) are in `totals` but in no week. `first_contacts` counts a prospect
  once, in the week of the first recorded contact (a first appointment history row also dates a first contact).
