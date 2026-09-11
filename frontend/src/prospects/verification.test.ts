import { describe, expect, it } from 'vitest'

import type { EmailAlias } from '../api/prospects'
import { prospectDetail } from '../test/prospectsApi'
import { draftFromProspect, emptyDraft } from './prospectForm'
import { aliasState, employmentState, isStale, originLabel } from './verification'

const at = '2026-09-03T08:00:00+00:00'

function stored(fields: Partial<EmailAlias>) {
  const alias: EmailAlias = {
    id: 'e1',
    address: 'jean@exemple.example',
    is_primary: true,
    is_active: true,
    verification_status: 'unverified',
    last_verified_at: null,
    origin_type: 'manual',
    source_reference: null,
    imported_unverified: false,
    ...fields,
  }
  const [draft] = draftFromProspect(prospectDetail({ emails: [alias] })).emails
  if (!draft) throw new Error('no alias')
  return draft
}

const context = { kind: 'emails' as const, companyMoved: false, today: '2026-09-11', staleDays: null }

describe('verification labels', () => {
  it('says what the employment verification is, the pending action first', () => {
    const imported = prospectDetail({ employment_imported_unverified: true })
    const verified = prospectDetail({ verification_state: 'verified', employment_verified_at: at })
    const draft = draftFromProspect(verified)

    expect(employmentState({ prospect: imported, draft, companyMoved: false }).text).toBe('Valeurs importées, jamais vérifiées')
    expect(employmentState({ prospect: prospectDetail(), draft, companyMoved: false }).text).toBe('Emploi jamais vérifié')
    expect(employmentState({ prospect: verified, draft, companyMoved: false })).toMatchObject({ tone: 'success', text: 'Vérifié le 3 sept. 2026' })
    expect(employmentState({ prospect: verified, draft, companyMoved: true })).toMatchObject({ tone: 'warning', text: 'Nouvelle entreprise : emploi à vérifier' })
    const pending = { ...draft, verification: { action: 'verified_now' as const, day: '' } }
    expect(employmentState({ prospect: verified, draft: pending, companyMoved: true }).text).toBe('Vérifié aujourd’hui — à enregistrer')
    expect(employmentState({ prospect: null, draft: emptyDraft(), companyMoved: false }).text).toBe('Pas encore vérifié')
  })

  it('labels every alias state with a tone and a text', () => {
    expect(aliasState(stored({ origin_type: 'imported', imported_unverified: true }), context)).toMatchObject({ tone: 'warning', text: 'Importé, jamais vérifié' })
    expect(aliasState(stored({ verification_status: 'verified', last_verified_at: at }), context)).toMatchObject({ tone: 'success', text: 'Vérifié le 3 sept. 2026' })
    expect(aliasState(stored({ verification_status: 'verified', last_verified_at: at }), { ...context, companyMoved: true }).text).toBe('À revérifier (vérifié le 3 sept. 2026)')
    expect(aliasState(stored({ verification_status: 'verified', last_verified_at: at }), { ...context, staleDays: 5 }).text).toBe('Vérifié le 3 sept. 2026 · ancien')
    expect(aliasState(stored({ verification_status: 'invalid' }), context)).toMatchObject({ tone: 'danger', text: 'Invalide' })
    expect(aliasState(stored({ is_active: false, is_primary: false }), context)).toMatchObject({ tone: 'neutral', text: 'Ancienne adresse (inactive)' })
    expect(aliasState({ ...stored({}), verified_now: true }, context).text).toBe('Vérifié aujourd’hui — à enregistrer')
  })

  it('shows where an alias came from', () => {
    const imported = stored({ origin_type: 'imported', source_reference: 'base.xlsx / Prospects / ligne 7' })
    expect(originLabel('emails', imported)).toBe('Import · base.xlsx / Prospects / ligne 7')
    expect(originLabel('emails', { ...imported, value: 'autre@exemple.example' })).toBe('Corrigé à la main')
  })

  it('counts a verification as stale only past a configured threshold', () => {
    expect(isStale(at, '2026-09-11', null)).toBe(false)
    expect(isStale(at, '2026-09-11', 30)).toBe(false)
    expect(isStale(at, '2026-09-11', 5)).toBe(true)
  })
})
