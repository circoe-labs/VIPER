import type {
  CategoryDecision,
  Civility,
  CompanyDecision,
  Corrections,
  ImportDecisions,
  ImportReview,
  PreviewOptions,
  PreviewRow,
  ProspectResolution,
  ReferentDecision,
  RoleDecision,
} from '../api/imports'
import { foldText } from '../lib/text'

// The user's review decisions — overrides of the defaults the server proposed (backend review.py) — and what they
// mean before anything is written: effective resolution per row, rows that still block the commit, and the commit
// summary. The server validates the same rules again at commit time (plan_import).

export interface RowDecision {
  resolution?: ProspectResolution
  inactive?: boolean
}

export interface ReviewDecisions {
  // Cell corrections: they change the preview itself, so applying them re-runs the analysis.
  corrections: Corrections
  // Another prospect sheet than the detected one (re-runs the analysis).
  sheet: string | null
  roles: Record<string, RoleDecision>
  categories: Record<string, CategoryDecision>
  referents: Record<string, ReferentDecision>
  civilities: Record<string, Civility | null>
  // Year given to every week written without one (`S37`); null leaves them without date.
  weekYear: number | null
  // Per week number: a year, or null to leave that week without date whatever `weekYear` says.
  weeks: Record<string, number | null>
  companies: Record<string, CompanyDecision>
  rows: Record<number, RowDecision>
}

export const NO_DECISIONS: ReviewDecisions = {
  corrections: {},
  sheet: null,
  roles: {},
  categories: {},
  referents: {},
  civilities: {},
  weekYear: null,
  weeks: {},
  companies: {},
  rows: {},
}

export interface Provenance {
  legalBasis: string
  sourceReference: string
  acknowledgeReimport: boolean
}

export const DEFAULT_LEGAL_BASIS = 'Fichier historique Circoe — prospection B2B'

export function previewOptions(decisions: ReviewDecisions): PreviewOptions {
  return {
    mapping: decisions.sheet ? { sheet: decisions.sheet, header_row: null, columns: {} } : null,
    corrections: decisions.corrections,
  }
}

function rowReview(review: ImportReview, row: number) {
  const found = review.rows.find((item) => item.row_number === row)
  if (!found) throw new Error(`Row ${String(row)} is not in the review.`)
  return found
}

export function resolutionOf(review: ImportReview, decisions: ReviewDecisions, row: number): ProspectResolution {
  return decisions.rows[row]?.resolution ?? rowReview(review, row).default_resolution
}

export function isImported(resolution: ProspectResolution): boolean {
  return resolution.action !== 'exclude'
}

export type RowIssue = 'missing_name' | 'blocked' | 'attached_to_excluded'

const PERSON_REASONS = new Set(['same_email', 'same_person'])

function doNotContactTarget(row: PreviewRow, prospectId: string): boolean {
  return row.duplicates.some(
    (candidate) =>
      candidate.prospect_id === prospectId &&
      candidate.contactability === 'do_not_contact' &&
      candidate.reasons.some((reason) => PERSON_REASONS.has(reason)),
  )
}

// Why a row cannot be committed as decided (errors must be resolved or the row excluded), or null.
export function rowIssue(review: ImportReview, decisions: ReviewDecisions, row: PreviewRow): RowIssue | null {
  const resolution = resolutionOf(review, decisions, row.row_number)
  if (resolution.action === 'exclude') return null
  if (row.blocked_by_do_not_contact) {
    return resolution.action === 'attach' && doNotContactTarget(row, resolution.prospect_id) ? null : 'blocked'
  }
  if (resolution.action === 'create' && row.diagnostics.some((d) => d.code === 'prospect.missing_name')) {
    return 'missing_name'
  }
  if (resolution.action === 'attach_row') {
    const seen = new Set([row.row_number])
    let target = resolution.row
    let next = resolutionOf(review, decisions, target)
    while (next.action === 'attach_row' && !seen.has(target)) {
      seen.add(target)
      target = next.row
      next = resolutionOf(review, decisions, target)
    }
    if (next.action === 'exclude' || seen.has(target)) return 'attached_to_excluded'
  }
  return null
}

export function rowIssues(review: ImportReview, decisions: ReviewDecisions): Map<number, RowIssue> {
  const issues = new Map<number, RowIssue>()
  for (const row of review.preview.rows) {
    const issue = rowIssue(review, decisions, row)
    if (issue) issues.set(row.row_number, issue)
  }
  return issues
}

export function roleDecision(review: ImportReview, decisions: ReviewDecisions, key: string): RoleDecision {
  return decisions.roles[key] ?? review.roles.find((group) => group.key === key)?.default ?? { action: 'none' }
}

export function categoryDecision(review: ImportReview, decisions: ReviewDecisions, key: string): CategoryDecision {
  return (
    decisions.categories[key] ?? review.categories.find((group) => group.key === key)?.default ?? { action: 'ignore' }
  )
}

export function referentDecision(review: ImportReview, decisions: ReviewDecisions, key: string): ReferentDecision {
  return (
    decisions.referents[key] ?? review.referents.find((group) => group.key === key)?.default ?? { action: 'ignore' }
  )
}

export function companyDecision(review: ImportReview, decisions: ReviewDecisions, key: string): CompanyDecision {
  return (
    decisions.companies[key] ?? review.companies.find((group) => group.key === key)?.default ?? { action: 'create' }
  )
}

// Year given to a week without year: its own choice (null = no date), else the batch year.
export function weekYear(decisions: ReviewDecisions, key: string): number | null {
  return key in decisions.weeks ? (decisions.weeks[key] ?? null) : decisions.weekYear
}

// Monday of ISO week `week` of `year` (UTC date), or null when the year has no such week (week 53).
export function isoWeekMonday(year: number, week: number): Date | null {
  const january4 = new Date(Date.UTC(year, 0, 4))
  const monday = new Date(january4)
  monday.setUTCDate(january4.getUTCDate() - ((january4.getUTCDay() + 6) % 7) + (week - 1) * 7)
  const nextYear = new Date(Date.UTC(year + 1, 0, 4))
  const lastWeekMonday = new Date(nextYear)
  lastWeekMonday.setUTCDate(nextYear.getUTCDate() - ((nextYear.getUTCDay() + 6) % 7) - 7)
  return week >= 1 && monday <= lastWeekMonday ? monday : null
}

function distinctLabels(labels: string[]): string[] {
  const seen = new Map<string, string>()
  for (const label of labels) {
    const key = foldText(label)
    if (!seen.has(key)) seen.set(key, label.trim())
  }
  return [...seen.values()]
}

export interface CommitSummary {
  total: number
  imported: number
  excluded: number
  // New prospects.
  created: number
  // Rows completing an existing prospect, and the distinct prospects they complete.
  attachedRows: number
  attachedProspects: number
  // Rows merged into the prospect of another row of the file.
  merged: number
  companiesCreated: number
  companiesLinked: number
  rolesCreated: string[]
  categoriesCreated: string[]
  // Imported rows with a week without year: given a date, left without date.
  weeksDated: number
  weeksUndated: number
  blocking: number
}

export function commitSummary(review: ImportReview, decisions: ReviewDecisions): CommitSummary {
  const summary: CommitSummary = {
    total: review.rows.length,
    imported: 0,
    excluded: 0,
    created: 0,
    attachedRows: 0,
    attachedProspects: 0,
    merged: 0,
    companiesCreated: 0,
    companiesLinked: 0,
    rolesCreated: [],
    categoriesCreated: [],
    weeksDated: 0,
    weeksUndated: 0,
    blocking: rowIssues(review, decisions).size,
  }
  const attached = new Set<string>()
  const companies = new Set<string>()
  const categoryLabels: string[] = []
  for (const row of review.rows) {
    const resolution = resolutionOf(review, decisions, row.row_number)
    if (resolution.action === 'exclude') {
      summary.excluded += 1
      continue
    }
    summary.imported += 1
    if (resolution.action === 'create') summary.created += 1
    if (resolution.action === 'attach_row') summary.merged += 1
    if (resolution.action === 'attach') {
      summary.attachedRows += 1
      attached.add(resolution.prospect_id)
    }
    if (row.company_key) companies.add(row.company_key)
    for (const key of row.category_keys) {
      const decision = categoryDecision(review, decisions, key)
      if (decision.action === 'create') categoryLabels.push(decision.label)
    }
    if (row.week_key) {
      if (weekYear(decisions, row.week_key) === null) summary.weeksUndated += 1
      else summary.weeksDated += 1
    }
  }
  summary.attachedProspects = attached.size
  for (const key of companies) {
    if (companyDecision(review, decisions, key).action === 'create') summary.companiesCreated += 1
    else summary.companiesLinked += 1
  }
  summary.rolesCreated = distinctLabels(
    review.roles.flatMap((group) => {
      const decision = roleDecision(review, decisions, group.key)
      return decision.action === 'create' ? [decision.label] : []
    }),
  )
  summary.categoriesCreated = distinctLabels(categoryLabels)
  return summary
}

// The commit payload: the reviewed preview's identity, the provenance and the user's overrides only.
export function decisionsPayload(
  review: ImportReview,
  decisions: ReviewDecisions,
  provenance: Provenance,
): ImportDecisions {
  return {
    ...previewOptions(decisions),
    file_fingerprint: review.preview.summary.file_fingerprint,
    preview_digest: review.digest,
    legal_basis_or_collection_context: provenance.legalBasis.trim(),
    source_reference: provenance.sourceReference.trim(),
    acknowledge_reimport: provenance.acknowledgeReimport,
    roles: decisions.roles,
    categories: decisions.categories,
    referents: decisions.referents,
    civilities: decisions.civilities,
    week_year: decisions.weekYear,
    weeks: decisions.weeks,
    companies: decisions.companies,
    rows: decisions.rows,
  }
}

// `values` without the entry `key`.
export function without<T>(values: Record<string, T>, key: string | number): Record<string, T> {
  return Object.fromEntries(Object.entries(values).filter(([name]) => name !== String(key)))
}

function kept<T>(values: Record<string, T>, keys: Set<string>): Record<string, T> {
  return Object.fromEntries(Object.entries(values).filter(([key]) => keys.has(key)))
}

// After a new analysis (corrections, other sheet, changed Settings), decisions about values the file no longer
// contains are dropped; the server would refuse them.
export function prunedDecisions(decisions: ReviewDecisions, review: ImportReview): ReviewDecisions {
  const keys = (groups: { key: string }[]) => new Set(groups.map((group) => group.key))
  const rows = new Set(review.rows.map((row) => String(row.row_number)))
  return {
    ...decisions,
    roles: kept(decisions.roles, keys(review.roles)),
    categories: kept(decisions.categories, keys(review.categories)),
    referents: kept(decisions.referents, keys(review.referents)),
    civilities: kept(decisions.civilities, keys(review.civilities)),
    weeks: kept(decisions.weeks, keys(review.weeks)),
    companies: kept(decisions.companies, keys(review.companies)),
    rows: kept(decisions.rows, rows),
  }
}
