import { useQuery } from '@tanstack/react-query'

import { apiGet } from './client'

// Mirrors backend/app/api/routes/metrics.py: the truthful « cette semaine » read-model shared by Prospection, Contact
// and Home (slice S1). « Cette semaine » = Monday 00:00 inclusive to next Monday 00:00 exclusive, Europe/Paris.
// Definitions: doc/features/weekly-metrics.md. Sub-status weekly deltas of Prospection segments are NOT computable:
// `prospection_sub_status_deltas` is always null — render nothing, never difference two stock counts. The weekly
// delta of the review boxes (to_verify / verified / ignored) is `reviews[x].week` of GET /prospection/counters.

export interface WeeklyAdditions {
  // Records whose created_at falls in the week (modification dates never count).
  prospects: number
  companies: number
  // Warehouse sites (not their embedded contacts).
  warehouses: number
}

// Stock as of now (not weekly).
export interface ContactStock {
  // First contact planned, whatever its date (Prospection segment `to_contact`).
  to_contact: number
  // To send by the end of this week, overdue included (Contact « À envoyer »).
  to_send: number
  // Part of to_send due before this week's Monday.
  overdue: number
  first_contact_to_send: number
  // Follow-ups (rank >= 1) to send / overdue.
  follow_up_to_send: number
  follow_up_overdue: number
  // Sequence in progress, next send due after this week.
  upcoming: number
  // At least one real send, any sequence.
  contacted: number
  // State « Réponse reçue ».
  responses: number
  // « RDV pris » or a recorded appointment date (Prospection segment `appointments`).
  appointments: number
  // Open effective « Erreur sur le mail » (the same figure as Home's `mail_inactive`).
  mail_error: number
}

// Events recorded during the week; each prospect counted once per figure.
export interface ContactWeekEvents {
  // First real send (restatements by import / migration excluded).
  first_contacts: number
  first_appointments: number
  responses: number
  mail_errors_opened: number
  // Keys: response_received | appointment_obtained | not_interested | ignored | disqualified. Prospects whose status
  // history gained a row entering that state during the week (imports / migrations excluded).
  status_entries: Record<string, number>
}

export interface WeeklyMetrics {
  timezone: string
  // ISO week label, e.g. `2026-W43`; Monday and Sunday (inclusive) as ISO dates.
  week: string
  week_start: string
  week_end: string
  today: string
  additions: WeeklyAdditions
  contact_stock: ContactStock
  contact_events: ContactWeekEvents
  prospection_sub_status_deltas: null
}

export const metricsKeys = { all: ['metrics'] as const, weekly: ['metrics', 'weekly'] as const }

export function useWeeklyMetrics() {
  return useQuery({ queryKey: metricsKeys.weekly, queryFn: ({ signal }) => apiGet<WeeklyMetrics>('/metrics/weekly', signal) })
}

// GET /api/metrics/weekly-series?weeks=N (doc/features/weekly-metrics.md): the week-by-week history behind Home's
// charts, oldest week first, the current business week last. A week without recorded event is a true 0.
export interface WeekPoint {
  week: string
  week_start: string
  week_end: string
  additions: WeeklyAdditions
  // Prospects first contacted / answered / first appointment recorded in the week (imports and migrations excluded).
  first_contacts: number
  responses: number
  appointments: number
}

// Stock as of now (not a sum of the weeks): of the prospects really contacted, how many answered / hold an RDV.
export interface ConversionTotals {
  contacted: number
  responded: number
  with_appointment: number
}

export interface WeeklySeries {
  timezone: string
  today: string
  weeks: WeekPoint[]
  totals: ConversionTotals
}

export const SERIES_WEEKS = 12

export function useWeeklySeries(weeks = SERIES_WEEKS) {
  return useQuery({
    queryKey: [...metricsKeys.all, 'weekly-series', weeks] as const,
    queryFn: ({ signal }) => apiGet<WeeklySeries>(`/metrics/weekly-series?weeks=${String(weeks)}`, signal),
  })
}
