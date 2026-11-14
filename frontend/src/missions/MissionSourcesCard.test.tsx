import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { setCsrfToken } from '../api/client'
import type { MissionDetail, MissionSource } from '../api/missions'
import { type ApiReply, stubApi } from '../test/render'
import { detail, MISSION } from './missionTestData'
import { MissionSourcesCard } from './MissionSourcesCard'

const A = { id: 'src-a', url: 'https://www.annuaire.fr/liste', label: 'Annuaire', missions_count: 1 }
const B = { id: 'src-b', url: 'https://www.registre.fr', label: null, missions_count: 0 }
const C = { id: 'src-c', url: 'https://www.registre.fr/transport', label: 'Registre transport', parent_id: 'src-b', missions_count: 0 }
const LIBRARY: MissionSource[] = [A, B, C]

function mission(options: { inherited?: boolean; sources?: MissionSource[]; status?: 'active' | 'done' } = {}): MissionDetail {
  const { inherited = false, sources = [A, B], status = 'active' } = options
  const base = detail()
  return {
    ...base,
    card: { ...base.card, status },
    sources,
    inheritance: {
      category_id: 'cat-1',
      overridden_fields: inherited ? [] : ['sources'],
      prompt_inherited: true,
      skills_inherited: true,
      category_prompt: null,
      category_skills: [],
      sources_inherited: inherited,
      category_sources: [{ id: A.id, url: A.url, label: A.label }],
    },
  }
}

function show(data: MissionDetail, extra: Record<string, ApiReply> = {}) {
  setCsrfToken('csrf')
  stubApi({
    'GET /api/missions/sources': [200, LIBRARY],
    [`PATCH /api/missions/${MISSION}`]: [200, data],
    ...extra,
  })
  const fetchMock = vi.mocked(fetch)
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <MissionSourcesCard mission={data} />
    </QueryClientProvider>,
  )
  const lastPatch = () => {
    const call = fetchMock.mock.calls.filter(([, init]) => init?.method === 'PATCH').at(-1)
    const body = call?.[1]?.body
    return typeof body === 'string' ? (JSON.parse(body) as unknown) : undefined
  }
  return { lastPatch, fetchMock }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('MissionSourcesCard', () => {
  it('lists the sources read-only, with Modifier and no remove button', () => {
    show(mission())
    expect(screen.getByRole('heading', { name: 'Sources (2)' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Annuaire' })).toBeInTheDocument()
    expect(screen.getByText('Personnalisé')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Retirer/ })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Modifier les sources' })).toBeEnabled()
  })

  it('marks sources that come from the category and cannot be edited on a closed mission', () => {
    show(mission({ inherited: true, sources: [A] }))
    expect(screen.getByText('Hérité')).toBeInTheDocument()
    expect(screen.getByText('hérité de la catégorie')).toBeInTheDocument()
  })

  it('disables Modifier on a closed mission', () => {
    show(mission({ status: 'done' }))
    expect(screen.getByRole('button', { name: 'Modifier les sources' })).toBeDisabled()
  })

  it('removes a source and saves the remaining list once', async () => {
    const user = userEvent.setup()
    const { lastPatch } = show(mission())
    await user.click(screen.getByRole('button', { name: 'Modifier les sources' }))
    expect(screen.getByRole('button', { name: 'Enregistrer' })).toBeDisabled()

    await user.click(screen.getByRole('button', { name: 'Retirer Annuaire' }))
    expect(screen.getByText('Modifications non enregistrées')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Enregistrer' }))

    await waitFor(() => {
      expect(lastPatch()).toEqual({ source_ids: [B.id] })
    })
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Modifier les sources' })).toBeInTheDocument()
    })
  })

  it('materialises an inherited list on the first change', async () => {
    const user = userEvent.setup()
    const { lastPatch } = show(mission({ inherited: true, sources: [A] }))
    await user.click(screen.getByRole('button', { name: 'Modifier les sources' }))
    expect(screen.getByText('Hérité')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Ajouter depuis la bibliothèque' }))
    const dialog = await screen.findByRole('dialog', { name: 'Ajouter depuis la bibliothèque' })
    await user.click(await within(dialog).findByRole('checkbox', { name: /registre\.fr$/ }))
    await user.click(within(dialog).getByRole('button', { name: 'Ajouter (1)' }))
    expect(screen.getByText('Personnalisé')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Enregistrer' }))
    await waitFor(() => {
      expect(lastPatch()).toEqual({ source_ids: [A.id, B.id] })
    })
  })

  it('adds from the library, hiding what is already added and nesting sub-sources', async () => {
    const user = userEvent.setup()
    const { lastPatch } = show(mission({ sources: [A] }))
    await user.click(screen.getByRole('button', { name: 'Modifier les sources' }))
    await user.click(screen.getByRole('button', { name: 'Ajouter depuis la bibliothèque' }))
    const dialog = await screen.findByRole('dialog', { name: 'Ajouter depuis la bibliothèque' })

    await within(dialog).findByRole('checkbox', { name: /registre\.fr$/ })
    expect(within(dialog).queryByRole('checkbox', { name: /Annuaire/ })).not.toBeInTheDocument()
    const nested = within(dialog).getByRole('list', { name: 'Sous-sources de https://www.registre.fr' })
    await user.click(within(nested).getByRole('checkbox', { name: /Registre transport/ }))
    await user.click(within(dialog).getByRole('button', { name: 'Ajouter (1)' }))

    expect(screen.getByRole('link', { name: 'Registre transport' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Enregistrer' }))
    await waitFor(() => {
      expect(lastPatch()).toEqual({ source_ids: [A.id, C.id] })
    })
  })

  it('adds a manual URL through the library and reuses an address that already exists', async () => {
    const user = userEvent.setup()
    const created = { id: 'src-new', url: 'https://nouveau.example/a', label: 'Nouveau', missions_count: 0 }
    const { lastPatch } = show(mission({ sources: [A] }), {
      'POST /api/missions/sources': [201, created],
    })
    await user.click(screen.getByRole('button', { name: 'Modifier les sources' }))
    await user.click(screen.getByRole('button', { name: 'Ajouter manuellement' }))
    const dialog = await screen.findByRole('dialog', { name: 'Ajouter manuellement' })

    await user.type(within(dialog).getByLabelText(/Adresse du site/), 'nouveau.example')
    await user.click(within(dialog).getByRole('button', { name: 'Ajouter' }))
    expect(within(dialog).getByText(/Adresse invalide/)).toBeInTheDocument()

    await user.clear(within(dialog).getByLabelText(/Adresse du site/))
    await user.type(within(dialog).getByLabelText(/Adresse du site/), 'https://nouveau.example/a')
    await user.type(within(dialog).getByLabelText('Nom (facultatif)'), 'Nouveau')
    await user.click(within(dialog).getByRole('button', { name: 'Ajouter' }))

    expect(await screen.findByRole('link', { name: 'Nouveau' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Enregistrer' }))
    await waitFor(() => {
      expect(lastPatch()).toEqual({ source_ids: [A.id, created.id] })
    })
  })

  it('reuses the existing source when the address is already known (409)', async () => {
    const user = userEvent.setup()
    show(mission({ sources: [A] }), {
      'POST /api/missions/sources': [409, { detail: { message: 'Déjà enregistrée' } }],
    })
    await user.click(screen.getByRole('button', { name: 'Modifier les sources' }))
    await user.click(screen.getByRole('button', { name: 'Ajouter manuellement' }))
    const dialog = await screen.findByRole('dialog', { name: 'Ajouter manuellement' })
    await within(dialog).findByRole('button', { name: 'Ajouter' })
    await user.type(within(dialog).getByLabelText(/Adresse du site/), 'https://registre.fr/')
    // The library must be known before the conflict can be resolved.
    await waitFor(() => {
      expect(vi.mocked(fetch).mock.calls.some(([input]) => typeof input === 'string' && input.includes('/missions/sources'))).toBe(true)
    })
    await user.click(within(dialog).getByRole('button', { name: 'Ajouter' }))
    expect(await screen.findByRole('link', { name: 'https://www.registre.fr' })).toBeInTheDocument()
  })

  it('shows the server refusal when a manual link cannot be saved', async () => {
    const user = userEvent.setup()
    show(mission({ sources: [A] }), {
      'POST /api/missions/sources': [422, { detail: { code: 'invalid', message: 'Lien refusé par le serveur.' } }],
    })
    await user.click(screen.getByRole('button', { name: 'Modifier les sources' }))
    await user.click(screen.getByRole('button', { name: 'Ajouter manuellement' }))
    const dialog = await screen.findByRole('dialog', { name: 'Ajouter manuellement' })
    await user.type(within(dialog).getByLabelText(/Adresse du site/), 'https://exemple.fr')
    await user.click(within(dialog).getByRole('button', { name: 'Ajouter' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Lien refusé par le serveur.')
  })

  it('removes all sources after a confirmation and saves an empty list', async () => {
    const user = userEvent.setup()
    const { lastPatch } = show(mission())
    await user.click(screen.getByRole('button', { name: 'Modifier les sources' }))
    await user.click(screen.getByRole('button', { name: 'Tout retirer' }))
    const dialog = await screen.findByRole('dialog', { name: 'Retirer toutes les sources ?' })
    expect(lastPatch()).toBeUndefined()
    await user.click(within(dialog).getByRole('button', { name: 'Tout retirer' }))
    await waitFor(() => {
      expect(lastPatch()).toEqual({ source_ids: [] })
    })
  })

  it('reverts to the category sources by saving null', async () => {
    const user = userEvent.setup()
    const { lastPatch } = show(mission())
    await user.click(screen.getByRole('button', { name: 'Modifier les sources' }))
    await user.click(screen.getByRole('button', { name: 'Revenir aux sources de la catégorie' }))
    expect(screen.getByText('Hérité')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Revenir aux sources de la catégorie' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Enregistrer' }))
    await waitFor(() => {
      expect(lastPatch()).toEqual({ source_ids: null })
    })
  })

  it('shows the empty state of an own empty list, and keeps a draft safe behind a confirmation', async () => {
    const user = userEvent.setup()
    show(mission({ sources: [] }))
    expect(screen.getByText('Aucune source')).toBeInTheDocument()
    expect(screen.getByText('Personnalisé')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Modifier les sources' }))
    await user.click(screen.getByRole('button', { name: 'Revenir aux sources de la catégorie' }))
    await user.click(screen.getByRole('button', { name: 'Annuler' }))
    const dialog = await screen.findByRole('dialog', { name: 'Abandonner les modifications ?' })
    await user.click(within(dialog).getByRole('button', { name: 'Continuer à modifier' }))
    expect(screen.getByRole('button', { name: 'Enregistrer' })).toBeEnabled()
    await user.click(screen.getByRole('button', { name: 'Annuler' }))
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Abandonner' }))
    expect(screen.getByRole('button', { name: 'Modifier les sources' })).toBeInTheDocument()
    expect(screen.getByText('Personnalisé')).toBeInTheDocument()
  })

  it('shows the save failure and keeps the draft', async () => {
    const user = userEvent.setup()
    show(mission(), {
      [`PATCH /api/missions/${MISSION}`]: [409, { detail: { code: 'conflict', message: 'Cette mission est clôturée.' } }],
    })
    await user.click(screen.getByRole('button', { name: 'Modifier les sources' }))
    await user.click(screen.getByRole('button', { name: 'Retirer Annuaire' }))
    await user.click(screen.getByRole('button', { name: 'Enregistrer' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Cette mission est clôturée.')
    expect(screen.getByRole('button', { name: 'Enregistrer' })).toBeEnabled()
    expect(screen.queryByRole('link', { name: 'Annuaire' })).not.toBeInTheDocument()
  })
})
