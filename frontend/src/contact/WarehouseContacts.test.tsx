import { render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { describe, expect, it, vi } from 'vitest'

import { WarehouseContacts } from './WarehouseContacts'

vi.mock('../api/warehouses', () => {
  const day = 86_400_000
  const draft = (id: string, contact_name: string, send_state: string, offset: number, failure_code: string | null = null) => ({
    id, warehouse_name: 'Site Exemple', contact_name, contact_role: 'Responsable', recipient: `${id}@example.test`,
    scheduled_at: new Date(Date.now() + offset).toISOString(), send_state, failure_code,
    failed_at: failure_code ? new Date(Date.now() - day).toISOString() : null,
  })
  const data = [
    draft('later', 'Anne Exemple', 'scheduled', 5 * day),
    draft('due', 'Bruno Exemple', 'scheduled', -3_600_000),
    draft('failed', 'Chloé Exemple', 'failed', -2 * day, 'dispatch_overdue'),
    draft('doubt', 'David Exemple', 'uncertain', -day, 'send_draft:toolbox_timeout'),
    draft('done', 'Emma Exemple', 'sent', -day),
    draft('old', 'Fanny Exemple', 'planned', day),
  ]
  return { useWarehouseDrafts: () => ({ data, dataUpdatedAt: Date.now(), isPending: false, isError: false, refetch: vi.fn() }) }
})

describe('Warehouse contacts', () => {
  it('keeps every unsent mail listed whatever its day, and says why one did not leave', () => {
    render(<MemoryRouter><WarehouseContacts /></MemoryRouter>)
    const button = screen.getByRole('button', { name: /Prospects entrepôt/ })
    expect(button).toHaveTextContent('4 en attente d’envoi')
    expect(button).toHaveTextContent('3 à reprendre')
    // Open by itself: something needs attention.
    const section = within(screen.getByRole('region', { name: /Prospects entrepôt/ }))
    const line = (name: string) => section.getByText(name).closest('li')
    expect(line('Anne Exemple')).toHaveTextContent('Programmé')
    expect(line('Bruno Exemple')).toHaveTextContent('Heure passée, pas encore parti')
    expect(line('Chloé Exemple')).toHaveTextContent('Non parti')
    expect(line('Chloé Exemple')).toHaveTextContent('heure dépassée')
    expect(line('David Exemple')).toHaveTextContent('envoi non confirmé : peut-être parti')
    expect(section.queryByText('Emma Exemple')).not.toBeInTheDocument()
    // An old draft never leaves: it is history, not a send waiting.
    expect(section.queryByText('Fanny Exemple')).not.toBeInTheDocument()
  })
})
