import { describe, expect, it } from 'vitest'

import { BLOCKED_ID, LUC_ID, sampleReview } from '../test/importFixtures'
import {
  commitSummary,
  decisionsPayload,
  isoWeekMonday,
  NO_DECISIONS,
  prunedDecisions,
  resolutionOf,
  type ReviewDecisions,
  rowIssues,
  weekYear,
} from './importPlan'

function decided(update: Partial<ReviewDecisions>): ReviewDecisions {
  return { ...NO_DECISIONS, ...update }
}

describe('import plan', () => {
  it('takes the server defaults: exact matches only, duplicates attached, do-not-contact excluded', () => {
    const review = sampleReview()

    expect(resolutionOf(review, NO_DECISIONS, 5)).toEqual({ action: 'attach', prospect_id: LUC_ID })
    expect(resolutionOf(review, NO_DECISIONS, 6)).toEqual({ action: 'exclude' })
    expect([...rowIssues(review, NO_DECISIONS)]).toEqual([[4, 'missing_name']])
    expect(commitSummary(review, NO_DECISIONS)).toMatchObject({
      total: 5,
      imported: 4,
      excluded: 1,
      created: 3,
      attachedRows: 1,
      attachedProspects: 1,
      companiesCreated: 2,
      companiesLinked: 0,
      rolesCreated: [],
      weeksDated: 0,
      weeksUndated: 1,
      blocking: 1,
    })
  })

  it('lets an error row be excluded, and refuses to create or merge a blocked row', () => {
    const review = sampleReview()
    const excluded = decided({ rows: { 4: { resolution: { action: 'exclude' } } } })
    const created = decided({ rows: { 6: { resolution: { action: 'create' } } } })
    const attached = decided({ rows: { 6: { resolution: { action: 'attach', prospect_id: BLOCKED_ID } } } })
    const wrongTarget = decided({ rows: { 6: { resolution: { action: 'attach', prospect_id: LUC_ID } } } })

    expect(rowIssues(review, excluded).size).toBe(0)
    expect(commitSummary(review, excluded)).toMatchObject({ imported: 3, excluded: 2 })
    expect(rowIssues(review, created).get(6)).toBe('blocked')
    expect(rowIssues(review, attached).get(6)).toBeUndefined()
    expect(rowIssues(review, wrongTarget).get(6)).toBe('blocked')
  })

  it('flags a merge into an excluded row', () => {
    const review = sampleReview()
    const decisions = decided({
      rows: { 2: { resolution: { action: 'exclude' } }, 3: { resolution: { action: 'attach_row', row: 2 } } },
    })

    expect(rowIssues(review, decisions).get(3)).toBe('attached_to_excluded')
  })

  it('counts values created explicitly, once per label ignoring case and accents', () => {
    const review = sampleReview()
    const decisions = decided({ roles: { 'directeur fictif': { action: 'create', label: ' Directeur des opérations ' } } })

    expect(commitSummary(review, decisions).rolesCreated).toEqual(['Directeur des opérations'])
  })

  it('gives weeks a year only when chosen, for the batch or per week', () => {
    const review = sampleReview()

    expect(weekYear(decided({ weekYear: 2026 }), '37')).toBe(2026)
    expect(weekYear(decided({ weekYear: 2026, weeks: { '37': null } }), '37')).toBeNull()
    expect(weekYear(decided({ weeks: { '37': 2025 } }), '37')).toBe(2025)
    expect(commitSummary(review, decided({ weekYear: 2026 }))).toMatchObject({ weeksDated: 1, weeksUndated: 0 })
  })

  it('computes the Monday of an ISO week, and knows week 53 exists only in some years', () => {
    expect(isoWeekMonday(2026, 37)?.toISOString().slice(0, 10)).toBe('2026-09-07')
    expect(isoWeekMonday(2026, 1)?.toISOString().slice(0, 10)).toBe('2025-12-29')
    expect(isoWeekMonday(2026, 53)?.toISOString().slice(0, 10)).toBe('2026-12-28')
    expect(isoWeekMonday(2025, 53)).toBeNull()
  })

  it('sends the reviewed preview identity, the provenance and the overrides only', () => {
    const review = sampleReview()
    const decisions = decided({
      sheet: 'Base client ',
      corrections: { 4: { first_name: 'Zoé' } },
      rows: { 4: { resolution: { action: 'exclude' } } },
    })

    const payload = decisionsPayload(review, decisions, {
      legalBasis: '  Fichier historique  ',
      sourceReference: '',
      acknowledgeReimport: true,
    })

    expect(payload).toMatchObject({
      file_fingerprint: review.preview.summary.file_fingerprint,
      preview_digest: review.digest,
      legal_basis_or_collection_context: 'Fichier historique',
      acknowledge_reimport: true,
      mapping: { sheet: 'Base client ', header_row: null, columns: {} },
      corrections: { 4: { first_name: 'Zoé' } },
      rows: { 4: { resolution: { action: 'exclude' } } },
      roles: {},
    })
  })

  it('drops decisions about values a new analysis no longer contains', () => {
    const review = sampleReview()
    const decisions = decided({
      roles: { 'directeur fictif': { action: 'none' }, disparu: { action: 'none' } },
      rows: { 3: { inactive: true }, 99: { resolution: { action: 'exclude' } } },
    })

    const pruned = prunedDecisions(decisions, review)

    expect(Object.keys(pruned.roles)).toEqual(['directeur fictif'])
    expect(Object.keys(pruned.rows)).toEqual(['3'])
  })
})
