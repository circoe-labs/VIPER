import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { prospect, stubProspectionApi } from '../test/prospectionApi'
import { qualityAlert, stubProspectsApi } from '../test/prospectsApi'
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
  it('shows uncertain prospects alongside validated prospects in the chart', async () => {
    const validated = prospect('Anne', 'Validee', { employment_verified_at: '2026-10-29T09:00:00Z', review: 'verified' })
    const uncertain = prospect('Bruno', 'Incertain', {}, ['never_verified'])
    stubProspectsApi({ rows: [validated, uncertain], alerts: [qualityAlert({ prospect_id: uncertain.id })] })
    renderApp('/contacts-joignables')
    // Validation capsules replaced the chart: each state is a figure and the filter of its table.
    const capsules = await screen.findByRole('group', { name: 'Validation des prospects' })
    await waitFor(() => expect(within(capsules).getByRole('button', { name: /Incertains/ })).toHaveTextContent('1'))
    expect(within(capsules).getByRole('button', { name: /Emploi validé/ })).toHaveTextContent('1')
  })

  it('keeps the original prospection page and all its records available', async () => {
    stubProspectionApi({ prospects: people() })
    renderApp('/prospection')
    expect(screen.getByRole('heading', { level: 1, name: 'Prospection' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Prestations proposées' })).not.toBeInTheDocument()
    const list = await screen.findByRole('list', { name: 'Prospects' })
    expect(within(list).getAllByRole('listitem')).toHaveLength(5)
  })

  it('uses the Verification box, including unverified e-mail and missing channels', async () => {
    stubProspectionApi({ prospects: people() })
    renderApp('/contacts-joignables')
    // /contacts-joignables redirects to the Prospection view of validated jobs; the table is shown directly (no fold).
    expect(await screen.findByRole('heading', { level: 2, name: /Prospects dont l’emploi est validé/ })).toBeInTheDocument()
    const table = await screen.findByRole('table', { name: 'Prospects' })
    await userEvent.click(screen.getByRole('button', { name: 'Afficher les contacts de Sans entreprise' }))
    expect(table.querySelectorAll('tr[data-prospect-id]')).toHaveLength(3)
    expect(within(table).getByRole('link', { name: 'Bruno Joignable' })).toBeInTheDocument()
    expect(within(table).getByRole('link', { name: 'Claire Telephone' })).toBeInTheDocument()
    expect(within(table).queryByText('David Ignore')).not.toBeInTheDocument()
    expect(within(table).queryByText('Edith Incertaine')).not.toBeInTheDocument()
    expect(within(table).getAllByText('Validé')).toHaveLength(3)
  })

  it('searches within the validated scope, and « Réinitialiser » returns to the whole base', async () => {
    stubProspectionApi({ prospects: people() })
    renderApp('/contacts-joignables')
    await screen.findByRole('table', { name: 'Prospects' })
    await userEvent.type(screen.getByRole('searchbox', { name: /Rechercher : nom/ }), 'Bruno')
    await waitFor(() => { expect(screen.getByRole('table').querySelectorAll('tr[data-prospect-id]')).toHaveLength(1) })
    await userEvent.click(screen.getByRole('button', { name: 'Réinitialiser' }))
    // Reset clears every criterion, the validated scope included (the « Tous » view: the former list, no table).
    const list = await screen.findByRole('list', { name: 'Prospects' })
    expect(within(list).getAllByRole('listitem')).toHaveLength(5)
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
