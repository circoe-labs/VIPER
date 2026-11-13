import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import type { MissionSource } from '../api/missions'
import { CATEGORIES } from '../missions/missionTestData'
import { SHELL_API } from '../test/homeApi'
import { type ApiReply, renderApp, stubApi } from '../test/render'

const SKILL = {
  id: 'skill-1',
  name: 'Sources fiables',
  description: 'Toujours citer',
  content: 'Cite tes sources.',
  categories_count: 1,
  missions_count: 2,
}

function source(id: string, url: string, extra: Partial<MissionSource> = {}): MissionSource {
  return { id, url, label: null, missions_count: 0, successful_uses: 0, rolled_up_uses: 0, children_count: 0, parent_id: null, ...extra }
}

const LINKEDIN = source('s-root', 'https://linkedin.com', {
  label: 'LinkedIn',
  description: 'Réseau professionnel',
  children_count: 1,
  successful_uses: 2,
  rolled_up_uses: 5,
})
const JOBS = source('s-jobs', 'https://linkedin.com/jobs', { label: 'Offres', parent_id: 's-root', successful_uses: 3, rolled_up_uses: 3 })

function stub(extra: Record<string, ApiReply> = {}) {
  return stubApi({
    ...SHELL_API,
    'GET /api/mission-categories': [200, [...CATEGORIES, { ...CATEGORIES[4], id: 'cat-custom', key: null, is_system: false, name: 'Veille concurrence', missions_count: 0 }, { ...CATEGORIES[4], id: 'cat-used', key: null, is_system: false, name: 'Salons', missions_count: 3 }]],
    'GET /api/mission-skills': [200, [SKILL]],
    'GET /api/missions/sources': [200, [LINKEDIN, JOBS]],
    ...extra,
  })
}

describe('Administration › Catégories', () => {
  it('lists the categories with their type, and explains why a built-in or used one cannot be deleted', async () => {
    stub()
    renderApp('/administration/categories')

    expect(await screen.findByRole('heading', { level: 1, name: 'Catégories de mission' })).toBeInTheDocument()
    const list = await screen.findByRole('list', { name: 'Catégories de mission' })
    expect(within(list).getAllByRole('heading', { level: 2 })).toHaveLength(7)
    expect(within(list).getByRole('button', { name: 'Supprimer la catégorie Prospection' })).toBeDisabled()
    expect(within(list).getAllByText(/Catégorie intégrée : on la modifie/).length).toBeGreaterThan(0)
    expect(within(list).getByRole('button', { name: 'Supprimer la catégorie Salons' })).toBeDisabled()
    expect(within(list).getByText(/3 missions utilisent cette catégorie/)).toBeInTheDocument()
    expect(within(list).getByRole('button', { name: 'Supprimer la catégorie Veille concurrence' })).toBeEnabled()
  })

  it('creates a category with its icon, colour, prompt, default skills and sources', async () => {
    const fetchMock = stub({ 'POST /api/mission-categories': [201, CATEGORIES[0]] })
    const user = userEvent.setup()
    renderApp('/administration/categories')

    await user.click(await screen.findByRole('button', { name: 'Nouvelle catégorie' }))
    const dialog = await screen.findByRole('dialog', { name: 'Nouvelle catégorie' })
    await user.type(within(dialog).getByLabelText(/^Nom/), 'Salons')
    await user.selectOptions(within(dialog).getByRole('combobox', { name: 'Type d’exécution' }), 'Prospection ciblée')
    await user.click(within(dialog).getByRole('radio', { name: 'Radar' }))
    await user.type(within(dialog).getByLabelText(/Consigne générale/), 'Cherche les exposants.')
    await user.click(await within(dialog).findByRole('checkbox', { name: /Sources fiables/ }))
    await user.click(within(dialog).getByRole('button', { name: /Déplier les sous-sources de LinkedIn/ }))
    await user.click(within(dialog).getByRole('checkbox', { name: /Offres/ }))
    await user.click(within(dialog).getByRole('button', { name: 'Enregistrer' }))

    const call = fetchMock.mock.calls.find(([url, init]) => url.endsWith('/api/mission-categories') && init?.method === 'POST')
    expect(JSON.parse((call?.[1] as RequestInit).body as string)).toEqual({
      name: 'Salons',
      description: null,
      icon: 'radar',
      color: '#16a34a',
      general_prompt: 'Cherche les exposants.',
      mission_type: 'prospection',
      skill_ids: ['skill-1'],
      source_ids: ['s-jobs'],
    })
  })

  it('shows the server refusal inside the editor and keeps it open', async () => {
    stub({ 'PUT /api/mission-categories/cat-prospection': [403, { detail: 'Only an administrator manages mission categories and skills.' }] })
    const user = userEvent.setup()
    renderApp('/administration/categories')

    await user.click(await screen.findByRole('button', { name: 'Modifier la catégorie Prospection' }))
    const dialog = await screen.findByRole('dialog', { name: 'Modifier la catégorie' })
    expect(within(dialog).getByRole('combobox', { name: 'Type d’exécution' })).toBeDisabled()
    await user.click(within(dialog).getByRole('button', { name: 'Enregistrer' }))

    expect(await within(dialog).findByRole('alert')).toBeInTheDocument()
    expect(screen.getByRole('dialog', { name: 'Modifier la catégorie' })).toBeInTheDocument()
  })

  it('says why the list cannot load and retries', async () => {
    stub({ 'GET /api/mission-categories': [500, { detail: 'boom' }] })
    renderApp('/administration/categories')

    expect(await screen.findByRole('button', { name: 'Réessayer' })).toBeInTheDocument()
  })
})

describe('Administration › Skills', () => {
  it('lists skills with their usage, creates one and states what deletion detaches', async () => {
    const fetchMock = stub({ 'POST /api/mission-skills': [201, SKILL], 'DELETE /api/mission-skills/skill-1': [204] })
    const user = userEvent.setup()
    renderApp('/administration/skills')

    const list = await screen.findByRole('list', { name: 'Skills' })
    expect(within(list).getByText('1 catégorie')).toBeInTheDocument()
    expect(within(list).getByText('2 missions')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Nouveau skill' }))
    const dialog = await screen.findByRole('dialog', { name: 'Nouveau skill' })
    expect(within(dialog).getByRole('button', { name: 'Enregistrer' })).toBeDisabled()
    await user.type(within(dialog).getByLabelText(/^Nom/), 'Ton neutre')
    await user.type(within(dialog).getByLabelText(/^Instructions/), 'Reste factuel.')
    await user.click(within(dialog).getByRole('button', { name: 'Enregistrer' }))
    const post = fetchMock.mock.calls.find(([url, init]) => url.endsWith('/api/mission-skills') && init?.method === 'POST')
    expect(JSON.parse((post?.[1] as RequestInit).body as string)).toEqual({ name: 'Ton neutre', description: null, content: 'Reste factuel.' })

    await user.click(await screen.findByRole('button', { name: 'Supprimer le skill Sources fiables' }))
    const confirm = await screen.findByRole('dialog', { name: 'Supprimer ce skill ?' })
    expect(within(confirm).getByText(/retiré de 1 catégorie et de 2 missions/)).toBeInTheDocument()
  })
})

describe('Administration › Sources', () => {
  it('shows roots with their rolled-up successful uses, expands to sub-sources and adds a sub-source', async () => {
    const fetchMock = stub({ 'POST /api/missions/sources': [201, JOBS] })
    const user = userEvent.setup()
    renderApp('/administration/sources')

    const tree = await screen.findByRole('list', { name: 'Bibliothèque de sources' })
    expect(within(tree).getByText('5 utilisations réussies')).toBeInTheDocument()
    expect(within(tree).queryByText('Offres')).not.toBeInTheDocument()

    await user.click(within(tree).getByRole('button', { name: 'Déplier les sous-sources de LinkedIn' }))
    const children = within(tree).getByRole('list', { name: 'Sous-sources de LinkedIn' })
    expect(within(children).getByText('3 utilisations réussies')).toBeInTheDocument()

    await user.click(within(tree).getByRole('button', { name: 'Ajouter une sous-source à LinkedIn' }))
    const dialog = await screen.findByRole('dialog', { name: 'Nouvelle sous-source' })
    expect(within(dialog).getByRole('combobox', { name: 'Source parente' })).toHaveDisplayValue('LinkedIn')
    await user.type(within(dialog).getByLabelText(/^Adresse/), 'https://linkedin.com/company')
    await user.click(within(dialog).getByRole('button', { name: 'Enregistrer' }))

    const post = fetchMock.mock.calls.find(([url, init]) => url.endsWith('/api/missions/sources') && init?.method === 'POST')
    expect(JSON.parse((post?.[1] as RequestInit).body as string)).toMatchObject({
      url: 'https://linkedin.com/company',
      parent_id: 's-root',
    })
  })

  it('keeps the server refusal when a source is still in use', async () => {
    stub({ 'DELETE /api/missions/sources/s-jobs': [409, { detail: 'This source is still in use.' }] })
    const user = userEvent.setup()
    renderApp('/administration/sources')

    await user.click(await screen.findByRole('button', { name: 'Déplier les sous-sources de LinkedIn' }))
    await user.click(await screen.findByRole('button', { name: 'Supprimer la source Offres' }))
    const confirm = await screen.findByRole('dialog', { name: 'Supprimer cette source ?' })
    await user.click(within(confirm).getByRole('button', { name: 'Supprimer la source' }))

    expect(await within(confirm).findByRole('alert')).toBeInTheDocument()
  })
})
