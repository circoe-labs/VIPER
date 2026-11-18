import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { setCsrfToken } from '../api/client'
import type { Person, PersonLink } from '../api/links'
import { stubApi } from '../test/render'
import { ProspectLinksCard } from './ProspectLinksCard'

const ID = '00000000-0000-7000-a000-000000000001'
const self: Person = { kind: 'prospect', id: ID, name: 'Yamina Abdennour', company_id: null, company_name: null }
const robin: Person = { kind: 'member', id: 'm1', name: 'Robin Martin', company_id: null, company_name: null }
const paul: Person = { kind: 'prospect', id: 'p2', name: 'Paul Durand', company_id: 'c1', company_name: 'Acme' }

const LINKS: PersonLink[] = [
  { id: 'l1', a: self, b: robin, relation: 'frère', score: 100, note: null },
  { id: 'l2', a: paul, b: self, relation: 'amis', score: 40, note: null },
]

function mount(links: PersonLink[], props: { addRequest?: number; onOpenGraph?: () => void } = {}) {
  setCsrfToken('csrf')
  const fetchMock = stubApi({
    [`GET /api/links/person/prospect/${ID}`]: [200, links],
    'GET /api/links/relations': [200, ['frère', 'amis']],
    'GET /api/organizations/members': [200, []],
    'PATCH /api/links/l1': [200, { ...LINKS[0], relation: 'cousin', score: 60 }],
    'DELETE /api/links/l2': [500, { detail: 'boom' }],
  })
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const view = (extra: typeof props) => (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <ProspectLinksCard prospectId={ID} {...extra} />
      </MemoryRouter>
    </QueryClientProvider>
  )
  const result = render(view(props))
  return { fetchMock, rerender: (extra: typeof props) => { result.rerender(view(extra)) } }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('ProspectLinksCard', () => {
  it('says so in one line when there is no relation, and keeps « Lier à » at hand', async () => {
    mount([])
    expect(await screen.findByText('Aucune relation enregistrée pour l’instant.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Lier à' })).toBeInTheDocument()
    expect(screen.queryByRole('group', { name: 'Ajouter une relation' })).not.toBeInTheDocument()
  })

  it('lists each link as a compact row: the other person, the relation and the strength', async () => {
    mount(LINKS)
    const list = await screen.findByRole('list', { name: 'Relations du prospect' })
    const rows = within(list).getAllByRole('listitem')
    expect(rows).toHaveLength(2)
    expect(within(rows[0] as HTMLElement).getByText('Robin Martin')).toBeInTheDocument()
    expect(within(rows[0] as HTMLElement).getByText('frère')).toBeInTheDocument()
    expect(within(rows[0] as HTMLElement).getByRole('img', { name: 'Force du lien : 100 sur 100' })).toBeInTheDocument()
    expect(within(rows[1] as HTMLElement).getByRole('link', { name: 'Paul Durand' })).toBeInTheDocument()
    expect(within(rows[1] as HTMLElement).getByText('Acme')).toBeInTheDocument()
  })

  it('« Lier à » opens the inline add form; the sheet can open it too', async () => {
    const user = userEvent.setup()
    const { rerender } = mount(LINKS)
    await screen.findByRole('list', { name: 'Relations du prospect' })
    await user.click(screen.getByRole('button', { name: 'Lier à' }))
    expect(screen.getByRole('group', { name: 'Ajouter une relation' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Annuler' }))
    expect(screen.queryByRole('group', { name: 'Ajouter une relation' })).not.toBeInTheDocument()
    rerender({ addRequest: 1 })
    expect(await screen.findByRole('group', { name: 'Ajouter une relation' })).toBeInTheDocument()
    await waitFor(() => { expect(screen.getByRole('combobox', { name: 'Lié à' })).toHaveFocus() })
  })

  it('edits the relation and the strength of a link', async () => {
    const user = userEvent.setup()
    const { fetchMock } = mount(LINKS)
    await user.click(await screen.findByRole('button', { name: 'Modifier le lien avec Robin Martin' }))
    const relation = screen.getByLabelText('Nature du lien')
    await user.clear(relation)
    await user.type(relation, 'cousin')
    await user.click(screen.getByRole('button', { name: 'Enregistrer le lien' }))
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([, init]) => init?.method === 'PATCH')
      const body = call?.[1]?.body
      expect(typeof body === 'string' ? (JSON.parse(body) as unknown) : null).toMatchObject({ relation: 'cousin', score: 100 })
    })
  })

  it('shows an error when a link cannot be deleted (the server refuses)', async () => {
    const user = userEvent.setup()
    mount(LINKS)
    await user.click(await screen.findByRole('button', { name: 'Supprimer le lien avec Paul Durand' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Le lien n’a pas pu être supprimé.')
  })

  it('« Graph » asks the sheet to open the graph', async () => {
    const user = userEvent.setup()
    const onOpenGraph = vi.fn()
    mount(LINKS, { onOpenGraph })
    await user.click(await screen.findByRole('button', { name: 'Graph' }))
    expect(onOpenGraph).toHaveBeenCalledOnce()
  })
})
