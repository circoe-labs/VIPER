import { useQuery } from '@tanstack/react-query'

import { apiGet } from './client'
import type { AuditSource, HistoryActor } from './history'
import type { ImportBatch } from './imports'
import type { Segment, TrackingStatus } from './prospection'

// Mirrors backend/app/api/routes/home.py: the Home dashboard in one read (Task 16). Prospect counts are the
// Prospection segments (same keys and values as /api/prospection/counters); definitions in
// doc/features/home-dashboard.md.

export interface MonthProgress {
  // First day of the month (ISO date, Europe/Paris).
  month: string
  // Prospects contacted for the first time that month (their first real send; before sends existed, the status
  // history — imports excluded).
  contacted: number
  // Prospects whose state first became « RDV pris » that month.
  appointments: number
}

export interface ActionItem {
  prospect_id: string
  first_name: string | null
  last_name: string | null
  company_name: string | null
  tracking_status: TrackingStatus | null
  // Appointment, next due date or response date, depending on the group.
  at: string | null
  referent_name: string | null
}

export interface ActionGroup {
  total: number
  items: ActionItem[]
}

// One save on a prospect or a company, grouped and summarized by the history formatter (Task 19).
export interface EditItem {
  occurred_at: string
  actor: HistoryActor
  source: AuditSource | null
  subject_type: string
  subject_id: string | null
  // Current name of the person or company; null once deleted.
  subject_label: string | null
  // What the save did, without values (« E-mail principal modifié », « Suivi : Contacté → R1 »).
  summary: string[]
}

// What the cards add to the segment counts.
export interface HomeFigures {
  // « Défaillant »: no answer after the last follow-up, confirmed by a person.
  disqualified: number
  // An open « Erreur sur le mail »: still in the role, but the mails come back.
  mail_inactive: number
  // No e-mail or no phone.
  incomplete: number
  responses_this_week: number
  responses_last_week: number
  responses_this_month: number
}

export interface HomeData {
  today: string
  stale_threshold_days: number | null
  counts: Record<Segment, number>
  figures: HomeFigures
  companies: number
  progress: {
    contact_target: number
    appointment_target: number
    // Oldest first; the last one is the current month.
    months: MonthProgress[]
  }
  // The Contact planning of the current calendar week: Contacts and follow-ups to send (overdue included) and how many
  // are overdue — the Contact page's « À envoyer ».
  contact_week: { week: string; monday: string; to_send: number; overdue: number }
  next_actions: { appointments: ActionGroup; due: ActionGroup; responses: ActionGroup }
  recent_imports: ImportBatch[]
  recent_edits: EditItem[]
}

export const homeKeys = { all: ['home'] as const }

export function useHome() {
  return useQuery({ queryKey: homeKeys.all, queryFn: ({ signal }) => apiGet<HomeData>('/home', signal) })
}
