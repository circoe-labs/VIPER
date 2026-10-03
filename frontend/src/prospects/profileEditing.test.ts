import { describe, expect, it } from 'vitest'

import { dirtyTabs, sectionOfField, sectionsWithErrors, tabOfField, tabsWithErrors } from './profileEditing'
import { emptyDraft } from './prospectForm'

describe('profileEditing', () => {
  it('maps every field path to its Profil section and its tab', () => {
    expect(sectionOfField('last_name')).toBe('identity')
    expect(sectionOfField('emails.2.address')).toBe('emails')
    expect(sectionOfField('phones.0.number')).toBe('phones')
    expect(sectionOfField('company_id')).toBe('employment')
    expect(sectionOfField('employment_verification.day')).toBe('employment')
    expect(sectionOfField('tracking.status')).toBeNull()
    expect(tabOfField('tracking.appointment_time')).toBe('tracking')
    expect(tabOfField('provenance.legal_basis_or_collection_context')).toBe('tracking')
    expect(tabOfField('emails.0.address')).toBe('profile')
  })

  it('lists the sections and tabs holding errors', () => {
    const errors = { last_name: 'x', 'emails.0.address': 'y', 'tracking.status': 'z' }
    expect(sectionsWithErrors(errors).sort()).toEqual(['emails', 'identity'])
    expect(tabsWithErrors(errors)).toEqual({ profile: true, tracking: true })
    expect(tabsWithErrors({})).toEqual({ profile: false, tracking: false })
  })

  it('tells which tab holds the unsaved changes', () => {
    const baseline = emptyDraft()
    expect(dirtyTabs(baseline, baseline, false)).toEqual({ profile: false, tracking: false })
    expect(dirtyTabs({ ...baseline, first_name: 'Jeanne' }, baseline, false)).toEqual({ profile: true, tracking: false })
    const tracking = { ...baseline.tracking, status: 'r1' as const }
    expect(dirtyTabs({ ...baseline, tracking }, baseline, false)).toEqual({ profile: false, tracking: true })
  })
})
