import { describe, expect, it } from 'vitest'

import type { EditItem } from '../api/home'
import { describeEdit, editOrigin, editSubject, formatMoment } from './activity'

function edit(fields: Partial<EditItem>): EditItem {
  return {
    occurred_at: '2026-09-10T08:00:00+00:00',
    actor: { kind: 'human', label: 'Pilote Test', id: 'user-1', on_behalf_of: null },
    source: 'ui',
    subject_type: 'prospect',
    subject_id: 'id',
    subject_label: 'Jean Exemple',
    summary: [],
    ...fields,
  }
}

describe('Home activity lines', () => {
  it('reads the save as the formatter summarized it', () => {
    const save = edit({ summary: ['Changement d’entreprise', 'E-mail principal modifié', 'Suivi : Contacté → Relance 1'] })

    expect(describeEdit(save)).toBe('Changement d’entreprise · E-mail principal modifié · Suivi : Contacté → Relance 1')
  })

  it('names a deleted record, the explorer origin and an agent', () => {
    expect(editSubject(edit({ subject_label: null }))).toBe('Prospect supprimé')
    expect(editSubject(edit({ subject_type: 'company', subject_label: null }))).toBe('Entreprise supprimée')
    expect(editOrigin(edit({ source: 'database_explorer' }))).toBe('Pilote Test · via Base de données')
    expect(editOrigin(edit({}))).toBe('Pilote Test')
    const agent = { kind: 'agent' as const, label: 'Qualification', id: 'agent.q', on_behalf_of: null }
    expect(editOrigin(edit({ actor: agent, source: 'agent' }))).toBe('Agent « Qualification »')
  })

  it('dates in Paris time, without a time for a date stored at midnight', () => {
    expect(formatMoment('2026-09-14T08:30:00+00:00')).toBe('14 sept. à 10:30')
    expect(formatMoment('2026-09-13T22:00:00+00:00')).toBe('14 sept.')
    expect(formatMoment('2026-12-01T23:00:00+00:00')).toBe('2 déc.')
  })
})
