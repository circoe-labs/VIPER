import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import type { MissionTaskRow } from '../api/missions'
import { taskPlan, taskSplit } from './missionKinds'
import { MissionTasksPanel } from './MissionTasksPanel'

const company = (label: string) => ({ kind: 'company' as const, label })

describe('Nombre de tâches', () => {
  it('is chosen for a search and fixed by the records otherwise', () => {
    expect(taskPlan('prospection', [])).toEqual({ fixed: false, minimum: 1 })
    expect(taskPlan('prospection', [company('A'), company('B')])).toEqual({ fixed: false, minimum: 2 })
    expect(taskPlan('enrichment', [company('A'), { kind: 'prospect' }])).toEqual({ fixed: true, count: 2, per: 'fiche' })
    expect(taskPlan('signals', [company('A')])).toEqual({ fixed: true, count: 1, per: 'société' })
  })

  it('spreads the total evenly over the linked companies', () => {
    expect(taskSplit(50, [company('Gamma'), company('Alpha'), company('Beta')])).toEqual([
      { label: 'Alpha', count: 17 },
      { label: 'Beta', count: 17 },
      { label: 'Gamma', count: 16 },
    ])
  })

  it('pages 50 tasks and filters them by how they ended', async () => {
    const user = userEvent.setup()
    const tasks: MissionTaskRow[] = Array.from({ length: 50 }, (_, index) => ({
      id: String(index),
      type: 'find_employees',
      status: index === 49 ? 'submitted' : index < 3 ? 'failed' : 'pending',
      failure_code: index < 3 ? 'rejected' : null,
      company_id: 'c',
      company_name: 'Alpha',
      prospect_id: null,
      prospect_name: null,
      claimed_by_label: null,
      assigned_agent_id: null,
      result_id: index === 49 ? 'r' : null,
      submitted_at: null,
    }))
    render(<MissionTasksPanel tasks={tasks} onReview={vi.fn()} />)
    const list = screen.getByRole('list', { name: 'Tâches de la mission' })

    expect(within(list).getAllByRole('listitem')).toHaveLength(20)
    // The result waiting for a review comes first.
    expect(within(list).getAllByRole('listitem')[0]).toHaveTextContent('À relire')
    expect(screen.getByText('1–20 sur 50')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /Suivantes/ }))
    expect(screen.getByText('21–40 sur 50')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /^Refusée ?3$/ }))
    expect(within(list).getAllByRole('listitem')).toHaveLength(3)
  })
})
