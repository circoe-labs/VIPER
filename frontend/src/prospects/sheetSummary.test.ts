import { describe, expect, it } from 'vitest'

import { jobSentence, summarizeProspect, type SummaryInput } from './sheetSummary'

const base: SummaryInput = {
  role: 'Directeur',
  company: '2SN',
  ficheLabel: 'Fournie',
  email: 'verified',
  proximity: { state: 'reachable', pathCount: 4, label: 'Proche' },
  score: { evaluated: false, bandLabel: 'Moyen' },
}

describe('summarizeProspect', () => {
  it('writes the job, then fiche, e-mail, proximity and score status', () => {
    expect(summarizeProspect(base)).toEqual([
      'Directeur chez 2SN.',
      'Fiche fournie, e-mail vérifié, proximité proche (4 chemins). Score prospect non évalué.',
    ])
  })

  it('says a score once it is evaluated, with the backend band word', () => {
    const lines = summarizeProspect({ ...base, score: { evaluated: true, bandLabel: 'Élevé' } })
    expect(lines[1]).toContain('Score prospect élevé.')
  })

  it('names what is missing and never invents a value', () => {
    expect(summarizeProspect({ role: null, company: null, ficheLabel: null, email: 'none', proximity: null, score: null })).toEqual([
      'Rôle et entreprise non renseignés.',
      'Aucun e-mail.',
    ])
  })

  it('leaves proximity out while unknown and explains an empty or unreachable one', () => {
    expect(summarizeProspect({ ...base, proximity: null })[1]).not.toContain('proximité')
    expect(summarizeProspect({ ...base, proximity: { state: 'empty', pathCount: 0, label: 'Lointain' } })[1]).toContain('aucune relation enregistrée')
    expect(summarizeProspect({ ...base, proximity: { state: 'unreachable', pathCount: 0, label: 'Lointain' } })[1]).toContain('aucun membre Circoe relié')
  })

  it('uses the singular for one path', () => {
    expect(summarizeProspect({ ...base, proximity: { state: 'reachable', pathCount: 1, label: 'Accessible' } })[1]).toContain('(1 chemin)')
  })

  it('never repeats a person name: the input has none', () => {
    expect(JSON.stringify(summarizeProspect(base))).not.toMatch(/Fontaine|Pierre/)
  })
})

describe('jobSentence', () => {
  it.each([
    ['Directeur', null, 'Directeur (entreprise non renseignée).'],
    [null, '2SN', 'Rôle non renseigné chez 2SN.'],
  ])('%s / %s', (role, company, expected) => {
    expect(jobSentence(role, company)).toBe(expected)
  })
})
