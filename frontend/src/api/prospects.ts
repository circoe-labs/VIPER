import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { companyKeys } from './companies'
import { apiGet, apiRequest } from './client'
import { type ActivityStatus, type ChannelVerification, prospectionKeys, type TrackingStatus, type VerificationState } from './prospection'
import { settingsKeys } from './settings'

// Mirrors backend/app/api/routes/prospects.py: the Prospect editor's view model and writes (Task 15). Rules:
// backend/app/services/prospect_editor.py, contact_channels.py, doc/features/prospect-editor.md.

export type Civility = 'mr' | 'ms'
export type OriginType = 'imported' | 'manual' | 'published' | 'inferred' | 'other'
export type PhoneType = 'mobile' | 'landline' | 'other'
export type VerificationAction = 'keep' | 'verified_now' | 'verified_on' | 'clear'

export interface CompanySummary {
  id: string
  display_name: string
  legal_name: string | null
  siren: string | null
  email_domain: string | null
  website_url: string | null
  commercial_segment_label: string | null
  city: string | null
  prospect_count: number
}

export interface ValueRef {
  id: string
  label: string
  active: boolean
}

interface AliasFields {
  id: string
  is_primary: boolean
  is_active: boolean
  verification_status: ChannelVerification
  last_verified_at: string | null
  origin_type: OriginType
  source_reference: string | null
  // Imported and never verified (nor known invalid): the "to verify" treatment.
  imported_unverified: boolean
}

export interface EmailAlias extends AliasFields {
  address: string
}

export interface PhoneAlias extends AliasFields {
  number: string
  type: PhoneType
}

export interface Tracking {
  status: TrackingStatus
  // Days in business time (Europe/Paris), `YYYY-MM-DD`.
  planned_contact_on: string | null
  // e.g. `2026-W38`.
  planned_contact_week: string | null
  response_received_on: string | null
  appointment_on: string | null
  // `HH:MM:SS`, null when the appointment has no time.
  appointment_time: string | null
  referent: ValueRef | null
  status_since: string | null
}

export interface ProspectSource {
  id: string
  source_type: 'excel_import' | 'manual' | 'future_agent' | 'other'
  source_reference: string | null
  collected_at: string
  legal_basis_or_collection_context: string | null
  actor_display: string | null
  import_filename: string | null
}

export interface Prospect {
  id: string
  // Opaque aggregate version, sent back with every write (409 `conflict` when stale).
  version: string
  civility: Civility | null
  first_name: string | null
  last_name: string | null
  company: CompanySummary | null
  role: ValueRef | null
  exact_job_title: string | null
  activity_status: ActivityStatus
  employment_verified_at: string | null
  verification_state: VerificationState
  employment_imported_unverified: boolean
  contactability_status: 'contactable' | 'do_not_contact'
  do_not_contact_at: string | null
  do_not_contact_reason: string | null
  // Primary first, then active ones.
  emails: EmailAlias[]
  phones: PhoneAlias[]
  tracking: Tracking | null
  // Oldest first.
  sources: ProspectSource[]
  import_row_count: number
  // Business day, `YYYY-MM-DD`.
  today: string
  stale_threshold_days: number | null
  created_at: string
  updated_at: string
}

interface AliasInput {
  id: string | null
  is_primary: boolean
  is_active: boolean
  verification_status: ChannelVerification
  // The one-click « Vérifié »: verified, dated now by the server.
  verified_now: boolean
  source_reference: string | null
}

export interface EmailInput extends AliasInput {
  address: string
}

export interface PhoneInput extends AliasInput {
  number: string
  type: PhoneType
}

export interface TrackingInput {
  status: TrackingStatus
  planned_contact_on: string | null
  response_received_on: string | null
  appointment_on: string | null
  appointment_time: string | null
  referent_id: string | null
}

// The whole editable state (contactability has its own operation). Aliases are full lists.
export interface ProspectInput {
  civility: Civility | null
  first_name: string | null
  last_name: string | null
  company_id: string | null
  role_id: string | null
  // A new role, created with the save.
  role_label: string | null
  exact_job_title: string | null
  activity_status: ActivityStatus
  employment_verification: { action: VerificationAction; day: string | null }
  emails: EmailInput[]
  phones: PhoneInput[]
  // Null leaves the current tracking as it is.
  tracking: TrackingInput | null
}

export interface ProspectCreateInput extends ProspectInput {
  provenance: { legal_basis_or_collection_context: string; source_reference: string | null }
}

export const prospectKeys = {
  detail: (id: string) => ['prospects', id] as const,
}

function prospectPath(id: string): `/${string}` {
  return `/prospects/${encodeURIComponent(id)}`
}

export function useProspect(id: string | null) {
  return useQuery({
    queryKey: prospectKeys.detail(id ?? ''),
    queryFn: ({ signal }) => apiGet<Prospect>(prospectPath(id ?? ''), signal),
    enabled: id !== null,
    // Opening a prospect always reads it fresh (nothing is kept once the editor leaves it); the editor keeps its own
    // draft, so refetching under it would be useless.
    gcTime: 0,
    refetchOnWindowFocus: false,
  })
}

// Writes refresh the Prospection counters and pages (prospectionKeys.all), the companies (prospect counts) and the
// Settings lists (a role created inline, usage counts).
export function useProspectMutations() {
  const queryClient = useQueryClient()
  const saved = (prospect: Prospect) => {
    queryClient.setQueryData(prospectKeys.detail(prospect.id), prospect)
    void Promise.all([
      queryClient.invalidateQueries({ queryKey: prospectionKeys.all }),
      queryClient.invalidateQueries({ queryKey: companyKeys.all }),
      queryClient.invalidateQueries({ queryKey: settingsKeys.all }),
    ])
  }
  return {
    create: useMutation({
      mutationFn: (input: ProspectCreateInput) => apiRequest<Prospect>('POST', '/prospects', { body: input }),
      onSuccess: saved,
    }),
    update: useMutation({
      mutationFn: ({ id, version, input }: { id: string; version: string; input: ProspectInput }) =>
        apiRequest<Prospect>('PUT', prospectPath(id), { body: { ...input, version } }),
      onSuccess: saved,
    }),
    contactability: useMutation({
      mutationFn: ({ id, ...body }: { id: string; do_not_contact: boolean; reason: string; version: string }) =>
        apiRequest<Prospect>('PUT', `${prospectPath(id)}/contactability`, { body }),
      onSuccess: saved,
    }),
    remove: useMutation({
      mutationFn: ({ id, version }: { id: string; version: string }) =>
        apiRequest<undefined>('DELETE', `${prospectPath(id)}?version=${encodeURIComponent(version)}`),
      onSuccess: (_, { id }) => {
        queryClient.removeQueries({ queryKey: prospectKeys.detail(id) })
        void Promise.all([
          queryClient.invalidateQueries({ queryKey: prospectionKeys.all }),
          queryClient.invalidateQueries({ queryKey: companyKeys.all }),
        ])
      },
    }),
  }
}
