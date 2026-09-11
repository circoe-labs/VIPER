import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import type { SearchResults } from '../api/search'
import { company } from '../test/companiesApi'
import { renderApp } from '../test/render'
import { companyHit, establishmentHit, group, prospectHit, searchResults } from '../test/searchApi'

// The shell's global search against a fake /api/search (see backend tests for matching and ranking).

type SearchReply = SearchResults | 'error' | Promise<Response>

interface SearchCall {
  q: string
  signal: AbortSignal | null | undefined
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

// /api/search answered by `reply(q)`; the health probe is up; a company opened in the editor is found; anything else
// answers 404. Returns the search calls (query and AbortSignal) in order.
function stubSearch(reply: (q: string) => SearchReply) {
  const calls: SearchCall[] = []
  const fetchMock = vi.fn((input: string, init?: RequestInit) => {
    const url = new URL(input, 'http://localhost')
    if (url.pathname === '/api/search') {
      const q = url.searchParams.get('q') ?? ''
      calls.push({ q, signal: init?.signal })
      const answer = reply(q)
      if (answer instanceof Promise) return answer
      return Promise.resolve(answer === 'error' ? json(500, { detail: 'boom' }) : json(200, answer))
    }
    if (url.pathname === '/api/health') return Promise.resolve(json(200, { status: 'ok', database: 'ok' }))
    const opened = /^\/api\/companies\/([\w-]+)$/.exec(url.pathname)
    if (opened?.[1]) return Promise.resolve(json(200, company('Fret Témoin SARL', { id: opened[1] })))
    return Promise.resolve(json(404, { detail: 'Not Found' }))
  })
  vi.stubGlobal('fetch', fetchMock)
  return calls
}

function field() {
  return screen.getByRole('combobox', { name: 'Recherche globale' })
}

// The search's own live region (the sidebar has another one).
function announced() {
  const root = field().closest<HTMLElement>('.global-search')
  if (!root) throw new Error('No global search')
  return within(root).getByRole('status')
}

function options() {
  return within(screen.getByRole('listbox', { name: 'Résultats de la recherche' })).getAllByRole('option')
}

const FRET = companyHit('Fret Témoin SARL', { siren: '123456789', email_domain: 'fret.example', city: 'Lyon', prospect_count: 3 })
const PERSON = prospectHit('Jeanne Témoin', {
  sublabel: 'Directrice · Logistique',
  company_name: 'Fret Témoin SARL',
  badges: ['do_not_contact'],
  match: { field: 'email', kind: 'contains', value: 'jeanne@fret.example' },
})
const SITE = establishmentHit('Entrepôt Nord', FRET, { siret: '12345678900012', badges: ['primary'] })
const RESULTS = searchResults('fret', [group([PERSON]), group([FRET], true), group([SITE])])

describe('GlobalSearch', () => {
  it('searches once typing pauses and shows grouped, typed results', async () => {
    const calls = stubSearch(() => RESULTS)
    renderApp('/exploitation')

    expect(field()).toHaveAttribute('placeholder', 'Rechercher un prospect, une entreprise, un SIREN…')
    await userEvent.type(field(), 'fret')

    const listbox = await screen.findByRole('listbox', { name: 'Résultats de la recherche' })
    expect(calls.map((call) => call.q)).toEqual(['fret'])
    const groups = within(listbox).getAllByRole('group')
    expect(groups.map((element) => element.getAttribute('aria-label'))).toEqual([
      'Prospects',
      'Entreprises — premiers résultats, précisez la recherche pour les autres',
      'Établissements',
    ])
    const [person, fret, site] = options()
    expect(person).toHaveTextContent('Jeanne Témoin')
    expect(person).toHaveTextContent('Directrice · Logistique · Fret Témoin SARL · jeanne@fret.example')
    expect(person).toHaveTextContent('Ne pas contacter')
    expect(fret).toHaveTextContent('SIREN 123 456 789 · fret.example · Lyon · 3 prospects')
    expect(site).toHaveTextContent('Fret Témoin SARL · SIRET 123 456 789 00012')
    expect(site).toHaveTextContent('Principal')
    expect(field()).toHaveAttribute('aria-expanded', 'true')
    expect(field()).toHaveAttribute('aria-activedescendant', person?.id)
    expect(announced()).toHaveTextContent('3 résultats')
  })

  it('never lets a late answer to an earlier query replace the current results', async () => {
    let answerFirst: (response: Response) => void = () => undefined
    const calls = stubSearch((q) =>
      q === 'fr'
        ? new Promise<Response>((resolve) => {
            answerFirst = resolve
          })
        : searchResults(q, [group([companyHit('Fret Témoin SARL')])]),
    )
    renderApp('/exploitation')

    await userEvent.type(field(), 'fr')
    await waitFor(() => {
      expect(calls.map((call) => call.q)).toEqual(['fr'])
    })
    await userEvent.type(field(), 'et')
    expect(await screen.findByRole('option', { name: /Fret Témoin SARL/ })).toBeInTheDocument()

    expect(calls[0]?.signal?.aborted).toBe(true)
    answerFirst(json(200, searchResults('fr', [group([prospectHit('Réponse Périmée')])])))
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(options().map((option) => option.textContent)).toEqual([expect.stringContaining('Fret Témoin SARL')])
    expect(screen.queryByText('Réponse Périmée')).not.toBeInTheDocument()
  })

  it('moves with the arrows and opens the active result with Enter', async () => {
    stubSearch(() => RESULTS)
    const { router } = renderApp('/exploitation')
    await userEvent.type(field(), 'fret')
    await screen.findByRole('listbox')
    const [person, fret, site] = options()

    await userEvent.keyboard('{ArrowDown}')
    expect(fret).toHaveAttribute('aria-selected', 'true')
    expect(field()).toHaveAttribute('aria-activedescendant', fret?.id)
    await userEvent.keyboard('{ArrowDown}{ArrowDown}')
    expect(person).toHaveAttribute('aria-selected', 'true')
    await userEvent.keyboard('{ArrowUp}')
    expect(site).toHaveAttribute('aria-selected', 'true')

    await userEvent.keyboard('{Enter}')

    // An establishment opens its company in the Company editor.
    expect(await screen.findByRole('dialog')).toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/exploitation')
    expect(field()).toHaveValue('')
  })

  it('opens a prospect in Prospection and a row in the Database Explorer with Shift+Enter', async () => {
    stubSearch(() => RESULTS)
    const { router } = renderApp('/exploitation')
    await userEvent.type(field(), 'fret')
    await screen.findByRole('listbox')

    await userEvent.keyboard('{Enter}')
    expect(router.state.location.pathname).toBe('/prospection')
    expect(router.state.location.search).toBe(`?prospect=${PERSON.id}`)

    await userEvent.type(field(), 'fret')
    await screen.findByRole('listbox')
    await userEvent.keyboard('{ArrowDown}{Shift>}{Enter}{/Shift}')
    expect(router.state.location.pathname).toBe('/database/companies')
    expect(new URLSearchParams(router.state.location.search).get('filters')).toContain(FRET.id)
  })

  it('opens a result with the mouse, and its row from the secondary button', async () => {
    stubSearch(() => RESULTS)
    const { router } = renderApp('/exploitation')
    await userEvent.type(field(), 'fret')
    await screen.findByRole('listbox')

    await userEvent.click(screen.getByRole('button', { name: 'Voir dans la base de données : Entrepôt Nord' }))
    expect(router.state.location.pathname).toBe('/database/establishments')

    await userEvent.type(field(), 'fret')
    await userEvent.click(await screen.findByRole('option', { name: /Fret Témoin SARL SIREN/ }))
    expect(await screen.findByRole('dialog')).toBeInTheDocument()
  })

  it('is reached with Ctrl+K anywhere and « / » outside text fields', async () => {
    stubSearch(() => RESULTS)
    renderApp('/exploitation')

    await userEvent.keyboard('{Control>}k{/Control}')
    expect(field()).toHaveFocus()

    field().blur()
    await userEvent.keyboard('/')
    expect(field()).toHaveFocus()
    expect(field()).toHaveValue('')

    // In another text field « / » is a character; Ctrl+K still jumps to the search.
    field().blur()
    const other = document.createElement('input')
    document.body.append(other)
    await userEvent.type(other, 'a/b')
    expect(other).toHaveFocus()
    expect(other).toHaveValue('a/b')
    fireEvent.keyDown(other, { key: 'k', ctrlKey: true })
    expect(field()).toHaveFocus()
    other.remove()
  })

  it('closes with Escape, then clears; Tab closes and leaves the field', async () => {
    stubSearch(() => RESULTS)
    renderApp('/exploitation')
    await userEvent.type(field(), 'fret')
    await screen.findByRole('listbox')

    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    expect(field()).toHaveAttribute('aria-expanded', 'false')
    expect(field()).toHaveValue('fret')

    await userEvent.keyboard('{ArrowDown}')
    expect(await screen.findByRole('listbox')).toBeInTheDocument()
    await userEvent.keyboard('{Escape}{Escape}')
    expect(field()).toHaveValue('')

    await userEvent.type(field(), 'fret')
    await screen.findByRole('listbox')
    await userEvent.tab()
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    expect(field()).not.toHaveFocus()
  })

  it('asks for two characters, says when nothing matches and lets a failed search be retried', async () => {
    let fail = true
    const calls = stubSearch((q) => (q === 'zz' ? searchResults('zz', []) : fail ? 'error' : RESULTS))
    renderApp('/exploitation')

    await userEvent.type(field(), 'z')
    expect(screen.getByText('Saisissez au moins 2 caractères.')).toBeInTheDocument()
    await userEvent.type(field(), 'z')
    expect(await screen.findByText('Aucun résultat pour « zz ».')).toBeInTheDocument()
    expect(announced()).toHaveTextContent('Aucun résultat.')

    await userEvent.clear(field())
    await userEvent.type(field(), 'fret')
    expect(await screen.findByRole('alert')).toHaveTextContent('La recherche a échoué.')
    fail = false
    await userEvent.click(screen.getByRole('button', { name: 'Réessayer' }))
    expect(await screen.findByRole('listbox')).toBeInTheDocument()
    expect(calls.filter((call) => call.q === 'fret')).toHaveLength(2)
  })
})
