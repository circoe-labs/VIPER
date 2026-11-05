import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { prospect, stubProspectionApi } from '../test/prospectionApi'
import { renderApp } from '../test/render'

function people() {
  return [
    prospect('Anne', 'Validee', { review: 'verified', employment_verified_at: '2026-10-29T09:00:00Z', primary_email: 'anne@example.test', email_state: 'verified' }),
    prospect('Bruno', 'Joignable', { review: 'to_verify', employment_verified_at: '2026-10-29T09:00:00Z', primary_email: 'bruno@example.test', email_state: 'unverified' }),
    prospect('Claire', 'Telephone', { employment_verified_at: '2026-10-29T09:00:00Z' }),
    prospect('David', 'Ignore', { review: 'ignored', employment_verified_at: '2026-10-29T09:00:00Z' }),
    prospect('Edith', 'Incertaine', { primary_email: 'edith@example.test' }),
  ]
}

describe('Separate Verification-validated workspace', () => {
  it('keeps the original prospection page and all its records available', async () => {
    stubProspectionApi({ prospects: people() })
    renderApp('/prospection')
    expect(screen.getByRole('heading', { level: 1, name: 'Prospection' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Prestations proposées' })).not.toBeInTheDocument()
    await userEvent.click(await screen.findByRole('button', { name: 'Afficher la liste' }))
    const list = await screen.findByRole('list', { name: 'Prospects' })
    expect(within(list).getAllByRole('listitem')).toHaveLength(5)
  })

  it('uses the Verification box, including unverified e-mail and missing channels', async () => {
    stubProspectionApi({ prospects: people() })
    renderApp('/contacts-joignables')
    expect(screen.getByRole('heading', { level: 1, name: 'Prospects validés' })).toBeInTheDocument()
    const toggle = screen.getByRole('button', { name: 'Afficher la liste' })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('table', { name: 'Prospects' })).not.toBeInTheDocument()
    await userEvent.click(toggle)
    const table = await screen.findByRole('table', { name: 'Prospects' })
    await userEvent.click(screen.getByRole('button', { name: 'Afficher les contacts de Sans entreprise' }))
    expect(table.querySelectorAll('tr[data-prospect-id]')).toHaveLength(3)
    expect(within(table).getByRole('link', { name: 'Bruno Joignable' })).toBeInTheDocument()
    expect(within(table).getByRole('link', { name: 'Claire Telephone' })).toBeInTheDocument()
    expect(within(table).queryByText('David Ignore')).not.toBeInTheDocument()
    expect(within(table).queryByText('Edith Incertaine')).not.toBeInTheDocument()
    expect(within(table).getAllByText('Validé')).toHaveLength(3)
  })

  it('preserves the reachable scope after searching and resetting', async () => {
    stubProspectionApi({ prospects: people() })
    renderApp('/contacts-joignables')
    await userEvent.click(screen.getByRole('button', { name: 'Afficher la liste' }))
    await screen.findByRole('table', { name: 'Prospects' })
    await userEvent.type(screen.getByRole('searchbox', { name: /Rechercher : nom/ }), 'Bruno')
    await waitFor(() => { expect(screen.getByRole('table').querySelectorAll('tr[data-prospect-id]')).toHaveLength(1) })
    await userEvent.click(screen.getByRole('button', { name: 'Réinitialiser' }))
    await waitFor(() => { expect(screen.getByRole('table').querySelectorAll('tr[data-prospect-id]')).toHaveLength(3) })
  })
})


describe('Company grouping', () => {
  it('puts contacts under their own company, keeping namesakes distinct', async () => {
    const companyA = '00000000-0000-7000-a000-000000000001'
    const companyB = '00000000-0000-7000-a000-000000000002'
    const verified = { employment_verified_at: '2026-10-29T09:00:00Z' }
    stubProspectionApi({ prospects: [
      prospect('Anne', 'Un', { ...verified, company_id: companyA, company_name: 'Même nom' }),
      prospect('Bruno', 'Deux', { ...verified, company_id: companyB, company_name: 'Même nom' }),
      prospect('Claire', 'Trois', { ...verified, company_id: companyA, company_name: 'Même nom' }),
      prospect('David', 'Quatre', verified),
    ] })
    const { router } = renderApp('/contacts-joignables?sort=name')
    await userEvent.click(screen.getByRole('button', { name: 'Afficher la liste' }))
    const table = await screen.findByRole('table', { name: 'Prospects' })
    const groups = within(table).getAllByRole('rowgroup', { name: 'Même nom' })
    expect(groups).toHaveLength(2)
    const firstCompany = within(groups[0] as HTMLElement)
    const secondCompany = within(groups[1] as HTMLElement)
    const firstToggle = firstCompany.getByRole('button', { name: 'Afficher les contacts de Même nom' })
    expect(firstToggle).toHaveAttribute('aria-expanded', 'false')
    expect(firstCompany.queryByRole('link', { name: 'Anne Un' })).not.toBeInTheDocument()
    await userEvent.click(firstToggle)
    expect(firstToggle).toHaveAttribute('aria-expanded', 'true')
    expect(secondCompany.queryByRole('link', { name: 'Bruno Deux' })).not.toBeInTheDocument()
    await userEvent.click(secondCompany.getByRole('button', { name: 'Afficher les contacts de Même nom' }))
    expect(within(groups[0] as HTMLElement).getByRole('link', { name: 'Anne Un' })).toBeInTheDocument()
    expect(within(groups[0] as HTMLElement).getByRole('link', { name: 'Claire Trois' })).toBeInTheDocument()
    expect(within(groups[1] as HTMLElement).getByRole('link', { name: 'Bruno Deux' })).toBeInTheDocument()
    firstToggle.focus()
    await userEvent.keyboard('{Enter}')
    expect(firstToggle).toHaveAttribute('aria-expanded', 'false')
    expect(firstCompany.queryByRole('link', { name: 'Anne Un' })).not.toBeInTheDocument()
    expect(secondCompany.getByRole('link', { name: 'Bruno Deux' })).toBeVisible()
    expect(within(table).getByRole('rowgroup', { name: 'Sans entreprise' })).toBeInTheDocument()
    await userEvent.type(screen.getByRole('searchbox', { name: /Rechercher : nom/ }), 'Anne')
    await waitFor(() => { expect(new URLSearchParams(router.state.location.search).get('sort')).toBe('company') })
  })
})
