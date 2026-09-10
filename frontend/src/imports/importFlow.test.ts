import { describe, expect, it } from 'vitest'

import { commitResult, samplePreview } from '../test/importFixtures'
import { flowReducer, INITIAL_FLOW, type FlowAction, type FlowState } from './importFlow'
import { NO_DECISIONS } from './importPlan'

const FILE = new File(['synthétique'], 'base_synthetique.xlsx')

function run(...actions: FlowAction[]): FlowState {
  return actions.reduce(flowReducer, INITIAL_FLOW)
}

describe('import flow', () => {
  it('goes file → analysis → sheet → review → done', () => {
    const preview = samplePreview()

    expect(run({ type: 'choose', file: FILE })).toMatchObject({ step: 'analyzing', file: FILE })
    expect(run({ type: 'choose', file: FILE }, { type: 'analyzed', preview }).step).toBe('sheet')
    const reviewing = run({ type: 'choose', file: FILE }, { type: 'analyzed', preview }, { type: 'confirmSheet' })
    expect(reviewing.step).toBe('review')
    expect(flowReducer(reviewing, { type: 'committed', result: commitResult() }).step).toBe('done')
  })

  it('goes back to the file choice when the first analysis is refused', () => {
    const state = run({ type: 'choose', file: FILE }, { type: 'failed', message: 'Le fichier est vide.' })

    expect(state).toMatchObject({ step: 'idle', file: null, error: 'Le fichier est vide.' })
  })

  it('keeps the review and its decisions through a new analysis, pruning what disappeared', () => {
    const preview = samplePreview()
    const reviewing = run(
      { type: 'choose', file: FILE },
      { type: 'analyzed', preview },
      { type: 'confirmSheet' },
      {
        type: 'decide',
        update: (decisions) => ({
          ...decisions,
          roles: { 'directeur fictif': { action: 'create', label: 'Directeur' }, disparu: { action: 'none' } },
        }),
      },
      { type: 'reanalyze' },
    )
    expect(reviewing.reanalyzing).toBe(true)

    const again = flowReducer(reviewing, { type: 'analyzed', preview })

    expect(again).toMatchObject({ step: 'review', reanalyzing: false })
    expect(again.decisions.roles).toEqual({ 'directeur fictif': { action: 'create', label: 'Directeur' } })
    const failed = flowReducer(reviewing, { type: 'failed', message: 'Service indisponible.' })
    expect(failed).toMatchObject({ step: 'review', reanalyzing: false, error: 'Service indisponible.' })
  })

  it('confirms a sheet only from the sheet step, and resets everything', () => {
    const reviewing = run({ type: 'choose', file: FILE }, { type: 'confirmSheet' })

    expect(reviewing.step).toBe('analyzing')
    expect(flowReducer(reviewing, { type: 'reset' })).toEqual({ ...INITIAL_FLOW, decisions: NO_DECISIONS })
  })
})
