import { useQuery } from '@tanstack/react-query'

import { apiGet } from './client'
import type { AuditSource, HistoryActor } from './history'
import type { ImportBatch } from './imports'
import type { Segment, TrackingStatus } from './prospection'

// Mirrors backend/app/api/routes/home.py: the Home dashboard in one read (Task 16). Prospect counts are the
// Prospection segments (same keys and values as /api/prospection/counters); definitions in
// doc/features/home-dashboard.md.

export const COMMERCIAL_STAGES = ['quote_sent', 'quote_follow_up', 'won', 'not_interested'] as const
export type CommercialStage = (typeof COMMERCIAL_STAGES)[number]

export interface MonthProgress {
  // First day of the month (ISO date, Europe/Paris).
  month: string
  // Prospects contacted for the first time that month (status history, imports excluded).
  contacted: number
  // Prospects who reached an appointment stage for the first time that month.
  appointments: number
}

export interface ActionItem {
  prospect_id: string
  first_name: string | null
  last_name: string | null
  company_name: string | null
  tracking_status: TrackingStatus | null
  // Appointment, planned contact or response date, depending on the group.
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
  // What the save did, without values (« E-mail principal modifié », « Suivi : Contacté → Relance 1 »).
  summary: string[]
}

export interface HomeData {
  today: string
  stale_threshold_days: number | null
  counts: Record<Segment, number>
  companies: number
  stages: Record<CommercialStage, number>
  progress: {
    contact_target: number
    appointment_target: number
    // Oldest first; the last one is the current month.
    months: MonthProgress[]
  }
  next_actions: { appointments: ActionGroup; due: ActionGroup; responses: ActionGroup }
  recent_imports: ImportBatch[]
  recent_edits: EditItem[]
}

export const homeKeys = { all: ['home'] as const }

export function useHome() {
  return useQuery({ queryKey: homeKeys.all, queryFn: ({ signal }) => apiGet<HomeData>('/home', signal) })
}
