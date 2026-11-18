import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { Person } from '../api/links'
import type { Proximity } from '../api/proximity'
import { useProspectProximity } from '../api/proximity'
import { ProximityScoreCard } from './ProximityScoreCard'
import { describePath, proximityTone } from './proximityView'

vi.mock('../api/proximity', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/proximity')>()),
  useProspectProximity: vi.fn(),
}))

const person = (kind: Person['kind'], id: string, name: string): Person => ({ kind, id, name, company_id: null, company_name: null })
const robin = person('member', 'm1', 'Robin')
const paul = person('prospect', 'p2', 'Paul')
const anne = person('prospect', 'p1', 'Anne')

const reachable: Proximity = {
  prospect_id: 'p1',
  score: 48,
  state: 'reachable',
  path_count: 1,
  members: [{ member: robin, strength: 48 }],
  paths: [
    {
      member: robin,
      hops: 2,
      strength: 48,
      people: [robin, paul, anne],
      edges: [
        { a: robin, b: paul, relation: 'amis', score: 100 },
        { a: paul, b: anne, relation: 'frère', score: 80 },
      ],
    },
  ],
  formula_version: 1,
  max_hops: 3,
}

function mockQuery(value: Record<string, unknown>) {
  vi.mocked(useProspectProximity).mockReturnValue({ isPending: false, isError: false, data: undefined, ...value } as never)
}

describe('ProximityScoreCard', () => {
  beforeEach(() => {
    vi.mocked(useProspectProximity).mockReset()
  })

  it('shows the score, its band in words, the members and the best path', () => {
    mockQuery({ data: reachable })
    render(<ProximityScoreCard prospectId="p1" />)

    expect(screen.getByRole('group', { name: 'Score de proximité : 48 sur 100, accessible' })).toBeInTheDocument()
    expect(screen.getByText(/1 chemin · Robin/)).toBeInTheDocument()
    expect(screen.getByText('Robin → Paul (amis, 100) → Anne (frère, 80)')).toBeInTheDocument()
    expect(screen.getByText(/2 liens · force 48/)).toBeInTheDocument()
  })

  it('says it is loading', () => {
    mockQuery({ isPending: true })
    render(<ProximityScoreCard prospectId="p1" />)

    expect(screen.getByRole('status')).toHaveTextContent('Calcul de la proximité')
  })

  it('says there is no relation (empty)', () => {
    mockQuery({ data: { ...reachable, state: 'empty', score: 0, path_count: 0, members: [], paths: [] } })
    render(<ProximityScoreCard prospectId="p1" />)

    expect(screen.getByText(/Aucune relation enregistrée/)).toBeInTheDocument()
  })

  it('says no member reaches the prospect (unreachable)', () => {
    mockQuery({ data: { ...reachable, state: 'unreachable', score: 0, path_count: 0, members: [], paths: [] } })
    render(<ProximityScoreCard prospectId="p1" />)

    expect(screen.getByText(/Aucun membre Circoe n’est relié/)).toBeInTheDocument()
  })

  it('shows the error and retries on demand', async () => {
    const refetch = vi.fn()
    mockQuery({ isError: true, error: new Error('boom'), refetch })
    render(<ProximityScoreCard prospectId="p1" />)

    expect(screen.getByRole('alert')).toHaveTextContent('n’a pas pu être calculé')
    await userEvent.click(screen.getByRole('button', { name: 'Réessayer' }))
    expect(refetch).toHaveBeenCalledOnce()
  })
})

describe('proximityView', () => {
  it('describes a path from the member to the prospect', () => {
    const [path] = reachable.paths
    if (!path) throw new Error('fixture without a path')
    expect(describePath(path)).toBe('Robin → Paul (amis, 100) → Anne (frère, 80)')
  })

  it.each([
    [0, 'neutral'],
    [34, 'warning'],
    [67, 'success'],
  ])('tones %i as %s', (score, tone) => {
    expect(proximityTone(score)).toBe(tone)
  })
})
