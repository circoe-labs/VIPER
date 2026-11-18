import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { setCsrfToken } from '../../api/client'
import { COMMON, MISSION } from '../../missions/missionTestData'
import { stubApi } from '../../test/render'
import { ProspectContactButton, ProspectContextMenuSurface } from './ProspectContactAction'
import { ProspectMissionMenu } from './ProspectMissionMenu'
import { buildProspectMission, type MissionProspect } from './prospectMissionFactory'
import { CATEGORIES } from '../../missions/missionTestData'

const PROSPECT: MissionProspect = {
  id: '00000000-0000-7000-a000-000000000001',
  firstName: 'Yamina',
  lastName: 'Abdennour',
  roleLabel: 'responsable d’agence',
  companyId: '00000000-0000-7000-f000-000000000001',
  companyName: 'TCSI - Le Havre',
}

function mount(ui: React.ReactNode) {
  setCsrfToken('csrf')
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const router = createMemoryRouter(
    [
      { path: '/', element: ui },
      { path: '/contact', element: <p>Page contact</p> },
      { path: '/missions/:id', element: <p>Détail mission</p> },
    ],
    { initialEntries: ['/'] },
  )
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
  return router
}

function posted(fetchMock: ReturnType<typeof stubApi>) {
  const call = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST')
  return typeof call?.[1]?.body === 'string' ? (JSON.parse(call[1].body) as Record<string, unknown>) : null
}

const API = {
  ...COMMON,
  'GET /api/missions/assistant/capabilities': [200, { assistant: true, speech: false }],
} as const

afterEach(() => {
  vi.unstubAllGlobals()
  Reflect.deleteProperty(navigator, 'mediaDevices')
})

describe('buildProspectMission', () => {
  it('targets the prospect and carries company + identity context', () => {
    const result = buildProspectMission('relations', PROSPECT, CATEGORIES)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.input.targets).toEqual([{ kind: 'prospect', id: PROSPECT.id }])
    expect(result.input.context_refs).toEqual([{ kind: 'company', id: PROSPECT.companyId, note: 'TCSI - Le Havre' }])
    expect(result.input.prompt).toContain('Cherche les relations de Yamina Abdennour')
    expect(result.input.prompt).toContain('Yamina Abdennour')
    expect(result.input.run_now).toBe(false)
  })

  it('maps « Complète » to enrichment and refuses an empty « Autre »', () => {
    const complete = buildProspectMission('complete', PROSPECT, CATEGORIES)
    expect(complete.ok && complete.input.type).toBe('enrichment')
    expect(buildProspectMission('other', PROSPECT, CATEGORIES, '  ').ok).toBe(false)
  })
})

describe('ProspectMissionMenu', () => {
  it('« Réanalyse son score » asks the S4 reassessment (same prospect), not a generic mission', async () => {
    const user = userEvent.setup()
    const fetchMock = stubApi({
      ...API,
      [`POST /api/prospects/${PROSPECT.id}/score/reassessment`]: [
        200,
        {
          status: 'queued',
          task_id: 't1',
          mission_id: MISSION,
          run_id: null,
          result_id: null,
          requested_at: null,
          agent_label: null,
          failure_code: null,
          failure_message: null,
          proposal: null,
          decided_by: null,
          decided_at: null,
        },
      ],
    })
    mount(<ProspectMissionMenu prospect={PROSPECT} />)

    await user.click(screen.getByRole('button', { name: 'Mission' }))
    await user.click(screen.getByRole('button', { name: /Réanalyse son score/ }))

    expect(await screen.findByText('Réévaluation demandée')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Ouvrir la mission' })).toHaveAttribute('href', `/missions/${MISSION}`)
    const calls = fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')
    expect(calls).toHaveLength(1)
    expect(String(calls[0]?.[0])).toContain(`/prospects/${PROSPECT.id}/score/reassessment`)
  })

  it('opens a 2x2 menu, moves with arrows and creates a prospect-targeted mission', async () => {
    const user = userEvent.setup()
    const fetchMock = stubApi({
      ...API,
      'POST /api/missions': [201, { card: { id: MISSION } }],
    })
    mount(<ProspectMissionMenu prospect={PROSPECT} />)

    await user.click(screen.getByRole('button', { name: 'Mission' }))
    const tiles = screen.getAllByRole('button').filter((b) => b.classList.contains('pmm__tile'))
    expect(tiles.map((t) => t.querySelector('.pmm__tile-label')?.textContent)).toEqual([
      'Complète cette fiche',
      'Réanalyse son score',
      'Cherche ses relations',
      'Autre',
    ])

    tiles[0]?.focus()
    await user.keyboard('{ArrowRight}')
    expect(tiles[1]).toHaveFocus()
    await user.keyboard('{ArrowDown}')
    expect(tiles[3]).toHaveFocus()
    await user.keyboard('{ArrowLeft}{ArrowUp}')
    expect(tiles[0]).toHaveFocus()

    await waitFor(() => { expect(tiles[0]).toBeEnabled() })
    await user.keyboard('{Enter}')

    const link = await screen.findByRole('link', { name: 'Ouvrir la mission' })
    expect(link).toHaveAttribute('href', `/missions/${MISSION}`)
    const body = posted(fetchMock)
    expect(body?.targets).toEqual([{ kind: 'prospect', id: PROSPECT.id }])
    expect(body?.run_now).toBe(false)
    expect(body?.name).toBe('Compléter la fiche de Yamina Abdennour')
  })

  it('« Autre » sends the typed request and falls back to typing when the mic is unavailable', async () => {
    const user = userEvent.setup()
    const fetchMock = stubApi({ ...API, 'POST /api/missions': [201, { card: { id: MISSION } }] })
    mount(<ProspectMissionMenu prospect={PROSPECT} />)

    await user.click(screen.getByRole('button', { name: 'Mission' }))
    await user.click(screen.getByRole('button', { name: /Autre/ }))
    // jsdom has neither MediaRecorder nor SpeechRecognition: the mic is disabled, typing still works.
    expect(screen.getByRole('button', { name: 'Dicter' })).toBeDisabled()
    expect(screen.getByText(/dictée n’est pas disponible/)).toBeInTheDocument()
    const submit = screen.getByRole('button', { name: 'Créer la mission' })
    expect(submit).toBeDisabled()

    await user.type(screen.getByLabelText('Que doit faire l’agent ?'), 'Trouve son rôle exact')
    await user.click(submit)

    await screen.findByRole('link', { name: 'Ouvrir la mission' })
    const body = posted(fetchMock)
    expect(body?.targets).toEqual([{ kind: 'prospect', id: PROSPECT.id }])
    expect(String(body?.prompt)).toContain('Trouve son rôle exact')
  })

  it('explains a refused microphone and keeps typing possible', async () => {
    const user = userEvent.setup()
    stubApi({ ...API })
    // Browser recognition exists, but the person refuses the mic permission.
    vi.stubGlobal('webkitSpeechRecognition', function Recognition() { return {} })
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: () => Promise.reject(new DOMException('no', 'NotAllowedError')) },
    })
    mount(<ProspectMissionMenu prospect={PROSPECT} />)

    await user.click(screen.getByRole('button', { name: 'Mission' }))
    await user.click(screen.getByRole('button', { name: /Autre/ }))
    await user.click(screen.getByRole('button', { name: 'Dicter' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('L’accès au micro est refusé')
    await user.type(screen.getByLabelText('Que doit faire l’agent ?'), 'Texte écrit')
    expect(screen.getByRole('button', { name: 'Créer la mission' })).toBeEnabled()
  })

  it('shows the server error and keeps the menu open', async () => {
    const user = userEvent.setup()
    stubApi({ ...API, 'POST /api/missions': [422, { detail: 'Mission refusée.' }] })
    mount(<ProspectMissionMenu prospect={PROSPECT} />)

    await user.click(screen.getByRole('button', { name: 'Mission' }))
    const first = screen.getByRole('button', { name: /Complète cette fiche/ })
    await waitFor(() => { expect(first).toBeEnabled() })
    await user.click(first)

    expect(await screen.findByRole('alert')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Complète cette fiche/ })).toBeInTheDocument()
  })

  it('closes on Escape', async () => {
    const user = userEvent.setup()
    stubApi(API)
    mount(<ProspectMissionMenu prospect={PROSPECT} />)
    await user.click(screen.getByRole('button', { name: 'Mission' }))
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})

describe('Contact actions', () => {
  it('right click offers « Contacter » and opens the contact deep link', async () => {
    const user = userEvent.setup()
    const router = mount(
      <ProspectContextMenuSurface prospectId={PROSPECT.id}>
        <p>Fiche</p>
      </ProspectContextMenuSurface>,
    )
    await user.pointer({ keys: '[MouseRight]', target: screen.getByText('Fiche') })
    await user.click(await screen.findByRole('menuitem', { name: 'Contacter' }))
    await waitFor(() => { expect(router.state.location.pathname).toBe('/contact') })
    expect(router.state.location.search).toBe(`?prospect=${PROSPECT.id}`)
  })

  it('the explicit button does the same from the keyboard', async () => {
    const user = userEvent.setup()
    const router = mount(<ProspectContactButton prospectId={PROSPECT.id} />)
    await user.tab()
    expect(screen.getByRole('button', { name: 'Contacter' })).toHaveFocus()
    await user.keyboard('{Enter}')
    await waitFor(() => { expect(router.state.location.pathname).toBe('/contact') })
    expect(router.state.location.search).toBe(`?prospect=${PROSPECT.id}`)
  })
})
