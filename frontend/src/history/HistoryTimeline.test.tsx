import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import type { HistoryEntry } from '../api/history'
import { CurrentUserContext } from '../auth/currentUser'
import { historyEntry, historyPage } from '../test/historyApi'
import { stubApi, TEST_USER } from '../test/render'
import { HistoryTimeline } from './HistoryTimeline'

const PATH = 'GET /api/prospects/p1/history'

function show(entries: HistoryEntry[]) {
  const fetchMock = stubApi({ [PATH]: (url) => [200, historyPage(entries, url)] })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <CurrentUserContext value={TEST_USER}>
        <HistoryTimeline subject="prospects" id="p1" label="Historique du prospect" />
      </CurrentUserContext>
    </QueryClientProvider>,
  )
  return fetchMock
}

// The entries (the list's own items, not their change lines).
async function items(): Promise<HTMLElement[]> {
  const list = await screen.findByRole('list', { name: 'Historique du prospect' })
  return Array.from(list.children) as HTMLElement[]
}

describe('History timeline', () => {
  it('reads a save by the signed-in user with its change lines', async () => {
    show([
      historyEntry({
        occurred_at: '2026-09-10T08:30:00+00:00',
        title: 'Changement d’entreprise',
        changes: [
          { label: 'Entreprise', before: 'Transports Exemple SARL', after: 'Nouvel Employeur SAS' },
          { label: 'E-mail ajouté', before: null, after: 'nouvelle@exemple.example' },
          { label: 'Opposition enregistrée', before: null, after: null },
        ],
      }),
    ])

    const [entry] = (await items()) as [HTMLElement]
    expect(within(entry).getByText('Vous')).toBeInTheDocument()
    expect(entry).toHaveTextContent('Interface')
    expect(entry).toHaveTextContent('10 sept. 2026 à 10:30')
    expect(entry).toHaveTextContent('Changement d’entreprise')
    expect(entry).toHaveTextContent('Entreprise : Transports Exemple SARL → Nouvel Employeur SAS')
    expect(entry).toHaveTextContent('E-mail ajouté : nouvelle@exemple.example')
    expect(entry).toHaveTextContent(/Opposition enregistrée$/)
  })

  it('names an import, the system, an agent and another person', async () => {
    show([
      historyEntry({ actor: { kind: 'import', label: 'base.xlsx', id: 'b1', on_behalf_of: 'Pilote Test' }, source: 'import' }),
      historyEntry({ actor: { kind: 'system', label: 'Suggestions VIPER', id: 'app.seed', on_behalf_of: null }, source: 'cli' }),
      historyEntry({ actor: { kind: 'agent', label: 'Qualification', id: 'agent.q', on_behalf_of: null }, source: 'agent' }),
      historyEntry({ actor: { kind: 'human', label: 'Claire Test', id: 'u2', on_behalf_of: null }, source: 'database_explorer' }),
    ])

    const [imported, system, agent, other] = (await items()) as [HTMLElement, HTMLElement, HTMLElement, HTMLElement]
    expect(imported).toHaveTextContent('Import « base.xlsx »Import · confirmé par Pilote Test')
    expect(system).toHaveTextContent('SystèmeLigne de commande · Suggestions VIPER')
    expect(agent).toHaveTextContent('AgentAgent · Qualification')
    expect(other).toHaveTextContent('Claire TestBase de données')
  })

  it('reads older saves with « Voir plus »', async () => {
    const entries = Array.from({ length: 12 }, (_, index) => historyEntry({ title: `Modification ${String(index + 1)}` }))
    const fetchMock = show(entries)

    expect(await items()).toHaveLength(10)
    await userEvent.click(screen.getByRole('button', { name: 'Voir plus' }))

    expect(await screen.findByText('Modification 12')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Voir plus' })).not.toBeInTheDocument()
    expect(String(fetchMock.mock.calls.at(-1)?.[0])).toContain(`before=${entries[9]?.id ?? ''}`)
  })

  it('folds a long creation behind « Afficher les N autres »', async () => {
    const changes = Array.from({ length: 8 }, (_, index) => ({ label: `Champ ${String(index + 1)}`, before: null, after: 'x' }))
    show([historyEntry({ title: 'Fiche créée', changes })])

    const [entry] = (await items()) as [HTMLElement]
    expect(entry).not.toHaveTextContent('Champ 8')
    await userEvent.click(within(entry).getByRole('button', { name: 'Afficher les 3 autres' }))
    expect(entry).toHaveTextContent('Champ 8')
  })

  it('says when there is nothing yet', async () => {
    show([])

    expect(await screen.findByText('Aucune modification enregistrée pour l’instant.')).toBeInTheDocument()
  })
})
