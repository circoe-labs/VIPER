import { describe, expect, it } from 'vitest'

import type { HistoryActor } from '../api/history'
import { absoluteMoment, actorBadge, actorDetails, actorName, relativeMoment } from './format'

const ME = 'user-1'

function actor(fields: Partial<HistoryActor>): HistoryActor {
  return { kind: 'human', label: 'Paul Test', id: ME, on_behalf_of: null, ...fields }
}

describe('history actors and sources', () => {
  it('badges the signed-in person, another person, an import, the system and an agent', () => {
    expect(actorBadge(actor({}), ME)).toEqual({ text: 'Vous', tone: 'accent' })
    expect(actorBadge(actor({ id: 'user-2', label: 'Claire Test' }), ME)).toEqual({ text: 'Claire Test', tone: 'neutral' })
    expect(actorBadge(actor({ kind: 'import', label: 'base.xlsx', id: 'batch' }), ME).text).toBe('Import « base.xlsx »')
    expect(actorBadge(actor({ kind: 'system', label: 'Ligne de commande', id: 'app.cli' }), ME).text).toBe('Système')
    expect(actorBadge(actor({ kind: 'agent', label: 'Qualification', id: 'agent.q' }), ME).text).toBe('Agent')
  })

  it('details the source, a command or agent label and who confirmed an import', () => {
    expect(actorDetails(actor({}), 'ui')).toEqual(['Interface'])
    expect(actorDetails(actor({ kind: 'import', label: 'base.xlsx', on_behalf_of: 'Paul Test' }), 'import')).toEqual([
      'Import',
      'confirmé par Paul Test',
    ])
    expect(actorDetails(actor({ kind: 'system', label: 'Suggestions VIPER' }), 'cli')).toEqual([
      'Ligne de commande',
      'Suggestions VIPER',
    ])
    expect(actorDetails(actor({ kind: 'system', label: 'Ligne de commande' }), 'cli')).toEqual(['Ligne de commande'])
    expect(actorDetails(actor({}), 'database_explorer')).toEqual(['Base de données'])
    expect(actorName(actor({ kind: 'agent', label: 'Qualification' }))).toBe('Agent « Qualification »')
  })
})

describe('history dates', () => {
  const now = new Date('2026-09-11T10:00:00+00:00').getTime()

  it('says how long ago, up to a month', () => {
    expect(relativeMoment('2026-09-11T09:59:40+00:00', now)).toBe('à l’instant')
    expect(relativeMoment('2026-09-11T10:00:30+00:00', now)).toBe('à l’instant')
    expect(relativeMoment('2026-09-11T09:55:00+00:00', now)).toBe('il y a 5 minutes')
    expect(relativeMoment('2026-09-11T07:00:00+00:00', now)).toBe('il y a 3 heures')
    expect(relativeMoment('2026-09-10T09:00:00+00:00', now)).toBe('hier')
    expect(relativeMoment('2026-07-01T09:00:00+00:00', now)).toBeNull()
  })

  it('gives the absolute moment in Paris time', () => {
    expect(absoluteMoment('2026-09-11T08:32:00+00:00')).toBe('11 sept. 2026 à 10:32')
  })
})
