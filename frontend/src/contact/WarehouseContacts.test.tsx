import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { describe, expect, it, vi } from 'vitest'

import { WarehouseContacts } from './WarehouseContacts'

vi.mock('../api/warehouses', () => ({
  useWarehouseDrafts: () => ({ data: [
    { id: 'scheduled', warehouse_name: 'Site Exemple', contact_name: 'Anne Exemple', contact_role: 'Responsable', recipient: 'anne@example.test', scheduled_at: new Date(Date.now() + 86400000).toISOString(), send_state: 'scheduled' },
    { id: 'unvalidated', warehouse_name: 'Site Exemple', contact_name: 'Bruno Exemple', contact_role: 'Responsable', recipient: 'bruno@example.test', scheduled_at: new Date(Date.now() + 86400000).toISOString(), send_state: 'planned' },
  ], isPending: false, isError: false, refetch: vi.fn() }),
}))

describe('Warehouse contacts', () => {
  it('shows only validated warehouse drafts scheduled for tomorrow', async () => {
    render(<MemoryRouter><WarehouseContacts /></MemoryRouter>)
    const button = screen.getByRole('button', { name: /Prospects entrepôt/ })
    expect(button).toHaveTextContent('1 prévus demain')
    await userEvent.click(button)
    const section = screen.getByRole('region', { name: /Prospects entrepôt/ })
    expect(within(section).getByText('Anne Exemple')).toBeVisible()
    expect(within(section).getByText('anne@example.test')).toBeVisible()
    expect(within(section).queryByText('Bruno Exemple')).not.toBeInTheDocument()
    expect(within(section).getByRole('link', { name: /Gérer les fiches/ })).toHaveAttribute('href', '/prospection?entity=warehouse')
  })
})
