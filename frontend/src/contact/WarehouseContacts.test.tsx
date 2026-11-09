import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { describe, expect, it, vi } from 'vitest'

import { WarehouseContacts } from './WarehouseContacts'

vi.mock('../api/warehouses', () => ({
  useWarehouseCounts: () => ({ data: { contacts: 145 } }),
  useWarehouses: () => ({ data: { total: 1, items: [{ id: 'site-1', name: 'Site Exemple', city: 'Lyon', contacts: [{ full_name: 'Anne Exemple', role: 'Responsable', email: 'anne@example.test' }] }] }, isPending: false, isError: false, isFetching: false }),
}))

describe('Warehouse contacts', () => {
  it('shows the warehouse directory contacts without marking them contacted', async () => {
    render(<MemoryRouter><WarehouseContacts /></MemoryRouter>)
    const button = screen.getByRole('button', { name: /Prospects entrepôt/ })
    expect(button).toHaveTextContent('145 interlocuteurs')
    await userEvent.click(button)
    const section = screen.getByRole('region', { name: /Prospects entrepôt/ })
    expect(within(section).getByText('Anne Exemple')).toBeVisible()
    expect(within(section).getByText('anne@example.test')).toBeVisible()
    expect(within(section).getByText(/coordonnées sont à vérifier/)).toBeVisible()
    expect(within(section).getByRole('link', { name: /Gérer les fiches/ })).toHaveAttribute('href', '/warehouses')
  })
})
