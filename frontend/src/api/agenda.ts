import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { apiGet, apiRequest } from './client'
import { refreshAfterWrite } from './refresh'

// Mirrors backend/app/api/routes/agenda.py: the appointments taken (synced from Calendly or typed by hand), their
// follow-up (moved, no-show, done, cancelled) and the day-before reminders. Business days are Europe/Paris dates.

export type AppointmentStatus = 'scheduled' | 'cancelled' | 'completed' | 'no_show'

export interface AppointmentMail {
  step_label: string
  subject: string
  body_text: string
  sent_at: string
}

export interface Appointment {
  id: string
  source: 'calendly' | 'manual'
  title: string
  invitee_name: string
  invitee_email: string | null
  company_name: string | null
  host_name: string | null
  host_email: string | null
  starts_at: string
  ends_at: string
  location: string | null
  status: AppointmentStatus
  // Times the person moved the appointment.
  reschedule_count: number
  notes: string | null
  prospect: { id: string; name: string } | null
  // The Circoe person assigned to the appointment.
  referent: { id: string; label: string } | null
  // The last mail really sent to the prospect, said in the reminder.
  last_mail: AppointmentMail | null
}

export interface AppointmentCreate {
  title?: string
  invitee_name: string
  invitee_email?: string
  company_name?: string
  starts_at: string
  ends_at?: string
  referent_id?: string | null
  prospect_id?: string | null
  notes?: string
}

export interface AppointmentPatch {
  status?: AppointmentStatus
  // A new start is « décalé »: the server counts the move and puts the appointment back to « scheduled ».
  starts_at?: string
  ends_at?: string
  referent_id?: string | null
  notes?: string | null
  prospect_id?: string | null
}

export interface SyncResult {
  ok: boolean
  // `calendly_not_configured`, `calendly_unauthorized`, `calendly_unreachable`… when not ok.
  code: string | null
  created: number
  updated: number
  cancelled: number
}

export interface Reminders {
  today: Appointment[]
  tomorrow: Appointment[]
}

export interface AgendaRange {
  // Inclusive business days, YYYY-MM-DD.
  start: string
  end: string
}

export const agendaKeys = {
  all: ['agenda'] as const,
  range: (range: AgendaRange) => ['agenda', 'appointments', range.start, range.end] as const,
  reminders: ['agenda', 'reminders'] as const,
}

export function useAppointments(range: AgendaRange) {
  return useQuery({
    queryKey: agendaKeys.range(range),
    queryFn: ({ signal }) =>
      apiGet<{ items: Appointment[] }>(`/agenda/appointments?start=${range.start}&end=${range.end}`, signal),
  })
}

export function useReminders() {
  return useQuery({
    queryKey: agendaKeys.reminders,
    queryFn: ({ signal }) => apiGet<Reminders>('/agenda/reminders', signal),
  })
}

export function useAgendaMutations() {
  const queryClient = useQueryClient()
  const refresh = () => refreshAfterWrite(queryClient, [agendaKeys.all])
  return {
    create: useMutation({
      mutationFn: (body: AppointmentCreate) => apiRequest<Appointment>('POST', '/agenda/appointments', { body }),
      onSuccess: refresh,
    }),
    update: useMutation({
      mutationFn: ({ id, patch }: { id: string; patch: AppointmentPatch }) =>
        apiRequest<Appointment>('PATCH', `/agenda/appointments/${encodeURIComponent(id)}`, { body: patch }),
      onSuccess: refresh,
    }),
    sync: useMutation({
      mutationFn: () => apiRequest<SyncResult>('POST', '/agenda/sync'),
      onSuccess: refresh,
    }),
  }
}
