import { useQuery } from '@tanstack/react-query'

import { apiGet, apiRequest } from './client'

// Mirrors backend/app/api/routes/imports.py and the engine's JSON contract (backend/app/services/imports/models.py,
// review.py, decisions.py): Excel import review and commit (Task 09, doc/features/excel-import-export.md).
// Stateless review: the file stays in the browser and is sent again with every request.

export type JsonScalar = string | number | boolean | null
export type Severity = 'error' | 'warning' | 'info'
export type RowStatus = 'ok' | 'warning' | 'error'
export type MatchKind = 'exact' | 'contains' | 'similar' | 'partial' | 'inactive'
export type MatchReason =
  | 'same_email'
  | 'same_person'
  | 'same_name'
  | 'same_company_name'
  | 'similar_company_name'
  | 'same_email_domain'
export type Civility = 'mr' | 'ms'
export type Contactability = 'contactable' | 'do_not_contact'

export interface Diagnostic {
  code: string
  severity: Severity
  // French, never containing a cell value.
  message: string
  row: number | null
  column: string | null
  field: string | null
  value: JsonScalar
}

export interface TaxonomyMatch {
  id: string
  label: string
  match: MatchKind
  score: number
  requires_confirmation: boolean
  source_text: string
}

export interface ReferentMatch {
  id: string
  display: string
  match: MatchKind
  requires_confirmation: boolean
}

export interface CompanyCandidate {
  company_id: string
  display_name: string
  reasons: MatchReason[]
  confidence: number
}

export interface EstablishmentProposal {
  address_line1: string | null
  address_line2: string | null
  postal_code: string | null
  city: string | null
  country: string | null
}

export interface CompanyProposal {
  display_name: string
  match_key: string
  email_domain: string | null
  project_done_with_circoe: string | null
  project_type: string | null
  circoe_references: string | null
  client_approach: string | null
  activity_categories: TaxonomyMatch[]
  unmatched_categories: string[]
  segment_suggestion: TaxonomyMatch | null
  establishment: EstablishmentProposal | null
  candidates: CompanyCandidate[]
}

export interface ProspectProposal {
  civility: Civility | null
  first_name: string | null
  last_name: string | null
  exact_job_title: string | null
  role_suggestions: TaxonomyMatch[]
  activity_status_suggestion: 'active' | 'inactive' | 'unknown' | null
}

export interface TrackingProposal {
  status: string
  stages: string[]
  requires_review: boolean
  planned_contact: { planned_date: string | null; week: number | null; year: number | null; requires_year: boolean } | null
  appointment_date: string | null
  referent: ReferentMatch | null
  referent_suggestions: ReferentMatch[]
}

export interface LegacyValue {
  column: string
  header: string | null
  value: JsonScalar
  reason: 'unmapped_column' | 'opaque_field' | 'not_mapped_value' | 'corrected'
}

export interface DuplicateCandidate {
  kind: 'file_row' | 'existing_prospect'
  row: number | null
  prospect_id: string | null
  reasons: MatchReason[]
  confidence: number
  contactability: Contactability | null
}

export interface SourceCell {
  column: string
  value: JsonScalar
  mapped: boolean
  preserved: boolean
  copied_from_merge: boolean
  corrected: boolean
}

export interface PreviewRow {
  row_number: number
  status: RowStatus
  company: CompanyProposal | null
  prospect: ProspectProposal
  emails: { address: string; is_primary: boolean }[]
  phones: { number: string; type: 'mobile' | 'landline' | 'other'; is_primary: boolean; column: string }[]
  tracking: TrackingProposal | null
  legacy_metadata: Record<string, LegacyValue>
  duplicates: DuplicateCandidate[]
  blocked_by_do_not_contact: boolean
  diagnostics: Diagnostic[]
  cells: SourceCell[]
}

export interface ColumnMapping {
  column: string
  index: number
  header: string | null
  field: string | null
  matched_by: 'header' | 'position' | 'override' | 'none'
}

export interface ImportSummary {
  file_name: string
  file_format: 'xlsx' | 'csv'
  file_fingerprint: string
  encoding: string | null
  delimiter: string | null
  sheet: string | null
  header_row: number | null
  sheets: { name: string; status: 'imported' | 'skipped'; rows: number; merged_ranges: number }[]
  columns: ColumnMapping[]
  rows_total: number
  rows_empty: number
  rows_by_status: Record<RowStatus, number>
  counts_by_severity: Record<Severity, number>
  counts_by_code: Record<string, number>
  duplicate_email_groups: number
  notices: Diagnostic[]
}

// --- decisions (overrides of the review's defaults) ---

export type RoleDecision = { action: 'none' } | { action: 'existing'; role_id: string } | { action: 'create'; label: string }
export type CategoryDecision =
  | { action: 'ignore' }
  | { action: 'existing'; category_ids: string[] }
  | { action: 'create'; label: string }
  | { action: 'segment'; segment_id: string }
export type ReferentDecision = { action: 'ignore' } | { action: 'existing'; referent_id: string }
export type CompanyDecision = { action: 'create' } | { action: 'link'; company_id: string }
export type ProspectResolution =
  | { action: 'create' }
  | { action: 'attach'; prospect_id: string }
  | { action: 'attach_row'; row: number }
  | { action: 'exclude' }

export const CORRECTABLE_FIELDS = [
  'civility',
  'first_name',
  'last_name',
  'company_name',
  'job_title',
  'email',
  'phone',
  'mobile',
  'address',
  'planned_contact',
] as const
export type CorrectableField = (typeof CORRECTABLE_FIELDS)[number]
export type Corrections = Record<number, Partial<Record<CorrectableField, string | null>>>

export interface ImportMapping {
  sheet: string | null
  header_row: number | null
  columns: Record<string, string | null>
}

export interface PreviewOptions {
  mapping?: ImportMapping | null
  corrections?: Corrections
}

export interface ImportDecisions extends PreviewOptions {
  file_fingerprint: string
  preview_digest: string
  legal_basis_or_collection_context: string
  source_reference?: string
  acknowledge_reimport?: boolean
  roles?: Record<string, RoleDecision>
  categories?: Record<string, CategoryDecision>
  referents?: Record<string, ReferentDecision>
  civilities?: Record<string, Civility | null>
  week_year?: number | null
  weeks?: Record<string, number | null>
  companies?: Record<string, CompanyDecision>
  rows?: Record<number, { resolution?: ProspectResolution; inactive?: boolean }>
}

// --- review ---

export type MatchStatus = 'exact' | 'suggested' | 'inactive' | 'segment' | 'unmatched'
export type ReferentStatus =
  | 'exact'
  | 'partial'
  | 'ambiguous'
  | 'inactive'
  | 'unknown'
  | 'marker'
  | 'email_like'
  | 'week_marker'
  | 'note'

export interface RoleGroup {
  key: string
  text: string
  rows: number[]
  status: MatchStatus
  suggestions: TaxonomyMatch[]
  default: RoleDecision
}

export interface CategoryGroup {
  key: string
  text: string
  rows: number[]
  status: MatchStatus
  suggestions: TaxonomyMatch[]
  segment: TaxonomyMatch | null
  default: CategoryDecision
}

export interface ReferentGroup {
  key: string
  text: string
  rows: number[]
  status: ReferentStatus
  suggestions: ReferentMatch[]
  default: ReferentDecision
}

export interface WeekGroup {
  key: string
  week: number
  rows: number[]
}

export interface CivilityGroup {
  key: string
  text: string
  rows: number[]
}

export interface CompanyGroup {
  key: string
  display_name: string
  variants: string[]
  rows: number[]
  candidates: CompanyCandidate[]
  default: CompanyDecision
}

export interface ProspectRef {
  id: string
  first_name: string | null
  last_name: string | null
  company_name: string | null
  emails: string[]
  contactability: Contactability
}

export interface RowReview {
  row_number: number
  role_key: string | null
  category_keys: string[]
  referent_key: string | null
  week_key: string | null
  civility_key: string | null
  company_key: string | null
  inactive_suggested: boolean
  default_resolution: ProspectResolution
}

export interface ImportReview {
  preview: { summary: ImportSummary; rows: PreviewRow[] }
  digest: string
  roles: RoleGroup[]
  categories: CategoryGroup[]
  referents: ReferentGroup[]
  weeks: WeekGroup[]
  civilities: CivilityGroup[]
  companies: CompanyGroup[]
  prospects: ProspectRef[]
  rows: RowReview[]
}

export type BatchStatus = 'pending' | 'committed' | 'failed' | 'cancelled'

export interface ImportBatch {
  id: string
  filename: string
  sheet_names: string[]
  status: BatchStatus
  created_at: string
  committed_at: string | null
  actor_type: string
  actor_display: string
  rows_total: number
  rows_imported: number
  rows_skipped: number
  legal_basis_or_collection_context: string | null
  source_reference: string | null
}

export interface PreviewResult {
  review: ImportReview
  // Committed imports of the same file (same SHA-256), newest first.
  previous_imports: ImportBatch[]
}

export interface CommitResult {
  batch: ImportBatch
  counts: Record<string, number>
}

// Refusals (`detail`) of the import API: the file (with the engine's French diagnostic), a stale review, the
// re-import acknowledgement, decisions that cannot be applied, a failed write (nothing imported).
export interface DecisionError {
  code: string
  row: number | null
  group: string | null
  key: string | null
}

export type ImportRefusal =
  | { code: 'file_rejected'; message: string; diagnostic: Diagnostic }
  | { code: 'file_changed' | 'preview_outdated' | 'length_required' | 'invalid_request'; message: string }
  | { code: 'reimport_not_acknowledged'; message: string; previous: ImportBatch[] }
  | { code: 'invalid_decisions'; message: string; errors: DecisionError[] }
  | { code: 'duplicate'; message: string; field: string; existing: { id: string; label: string; active: boolean } | null }
  | { code: 'commit_failed'; message: string; batch_id: string; row: number | null; reason: string }

export const importKeys = {
  history: ['imports', 'history'] as const,
}

function upload(file: File, part: string, value: unknown): FormData {
  const form = new FormData()
  form.append('file', file, file.name)
  form.append(part, JSON.stringify(value))
  return form
}

export function previewImport(file: File, options: PreviewOptions): Promise<PreviewResult> {
  return apiRequest<PreviewResult>('POST', '/imports/preview', { body: upload(file, 'options', options) })
}

export function commitImport(file: File, decisions: ImportDecisions): Promise<CommitResult> {
  return apiRequest<CommitResult>('POST', '/imports/commit', { body: upload(file, 'decisions', decisions) })
}

export function useImportHistory() {
  return useQuery({
    queryKey: importKeys.history,
    queryFn: ({ signal }) => apiGet<ImportBatch[]>('/imports?limit=20', signal),
  })
}
