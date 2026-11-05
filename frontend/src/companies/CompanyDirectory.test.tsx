import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { MemoryRouter } from 'react-router'
import { describe, expect, it } from 'vitest'
import type { CompanyKindSelection } from '../api/companies'
import { company, stubCompaniesApi } from '../test/companiesApi'
import { CompanyDirectory } from './CompanyDirectory'
import { CompanyEditorProvider } from './CompanyEditorProvider'

function Harness() {
  const [kind, setKind] = useState<CompanyKindSelection>(null)
  return <CompanyDirectory value={kind} onChange={setKind} />
}
function mount() {
  return render(<MemoryRouter><QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><CompanyEditorProvider><Harness /></CompanyEditorProvider></QueryClientProvider></MemoryRouter>)
}

describe('Company directory within Prospection', () => {
  it('includes all 812 companies, including companies without prospects, and pages the real list', async () => {
    const api = stubCompaniesApi({ companies: Array.from({ length: 812 }, (_, index) => company(`Entreprise ${String(index).padStart(3, '0')}`, { prospect_count: index % 2 })) })
    mount()
    const all = screen.getByRole('button', { name: 'Toutes' })
    await waitFor(() => { expect(all).toHaveTextContent('812') })
    expect(screen.getByRole('button', { name: 'À classer' })).toHaveTextContent('812')
    expect(screen.getByRole('button', { name: 'PME' })).toHaveTextContent('0')
    expect(screen.getByRole('button', { name: 'Afficher les entreprises' })).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('table', { name: 'Liste des entreprises' })).not.toBeInTheDocument()
    await userEvent.click(all)
    const table = screen.getByRole('table', { name: 'Liste des entreprises' })
    expect(within(table).getAllByRole('row')).toHaveLength(51)
    expect(within(table).getByRole('button', { name: 'Entreprise 000' })).toBeVisible()
    const pager = screen.getByRole('navigation', { name: 'Pages des entreprises' })
    expect(pager).toHaveTextContent('1–50 sur 812')
    await userEvent.click(within(pager).getByRole('button', { name: 'Suivantes' }))
    await waitFor(() => { expect(pager).toHaveTextContent('51–100 sur 812') })
    expect(api.requests.some((request) => request.search.includes('offset=50'))).toBe(true)
    await userEvent.type(screen.getByRole('searchbox'), 'Entreprise 811')
    await waitFor(() => { expect(within(table).getAllByRole('row')).toHaveLength(2) })
    expect(within(table).getByRole('button', { name: 'Entreprise 811' })).toBeVisible()
    await userEvent.click(screen.getByRole('button', { name: 'Masquer les entreprises' }))
    expect(table).not.toBeVisible()
  })

  it('uses the stored categories, counting each company once regardless of its prospect count', async () => {
    stubCompaniesApi({ companies: [
      company('Institution exemple', { company_kind: 'institutional', prospect_count: 4 }),
      company('PME exemple', { company_kind: 'sme', prospect_count: 3 }),
      company('Groupe exemple', { company_kind: 'large', prospect_count: 2 }),
      company('Sans type', { prospect_count: 0 }),
    ] })
    mount()
    await waitFor(() => { expect(screen.getByRole('button', { name: 'Toutes' })).toHaveTextContent('4') })
    for (const [label, name] of [['Institutionnelles', 'Institution exemple'], ['PME', 'PME exemple'], ['Grosses entreprises', 'Groupe exemple'], ['À classer', 'Sans type']]) {
      const category = screen.getByRole('button', { name: label })
      expect(category).toHaveTextContent('1')
      await userEvent.click(category)
      const table = await screen.findByRole('table', { name: 'Liste des entreprises' })
      await waitFor(() => { expect(within(table).getAllByRole('row')).toHaveLength(2) })
      expect(within(table).getByRole('button', { name })).toBeVisible()
    }
  })
})
