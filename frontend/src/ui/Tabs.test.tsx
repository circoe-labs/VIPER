import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it } from 'vitest'

import { Tabs } from './Tabs'

type Id = 'a' | 'b' | 'c'

function Harness({ initial = 'a' }: { initial?: Id }) {
  const [selected, setSelected] = useState<Id>(initial)
  return (
    <Tabs
      label="Étapes"
      selected={selected}
      onSelect={setSelected}
      tabs={[
        { id: 'a', label: 'Contact', extra: <span>Envoyé</span> },
        { id: 'b', label: 'R1' },
        { id: 'c', label: 'R2' },
      ]}
    >
      <p>Panneau {selected}</p>
    </Tabs>
  )
}

describe('Tabs', () => {
  it('names the list, marks the selected tab and labels the panel with it', () => {
    render(<Harness />)
    expect(screen.getByRole('tablist', { name: 'Étapes' })).toBeInTheDocument()
    const tabs = screen.getAllByRole('tab')
    expect(tabs.map((tab) => tab.textContent)).toEqual(['ContactEnvoyé', 'R1', 'R2'])
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true')
    expect(tabs[1]).toHaveAttribute('aria-selected', 'false')
    const panel = screen.getByRole('tabpanel', { name: /Contact/ })
    expect(panel).toHaveTextContent('Panneau a')
    expect(tabs[0]).toHaveAttribute('aria-controls', panel.id)
  })

  it('offers one tab stop, the selected tab', async () => {
    render(<Harness initial="b" />)
    const [first, second, third] = screen.getAllByRole('tab')
    expect(first).toHaveAttribute('tabindex', '-1')
    expect(second).toHaveAttribute('tabindex', '0')
    expect(third).toHaveAttribute('tabindex', '-1')
    await userEvent.tab()
    expect(second).toHaveFocus()
  })

  it('moves and selects with the arrows (wrapping), Home and End', async () => {
    render(<Harness />)
    const [first, second, third] = screen.getAllByRole('tab')
    await userEvent.click(first as HTMLElement)

    await userEvent.keyboard('{ArrowRight}')
    expect(second).toHaveFocus()
    expect(second).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Panneau b')

    await userEvent.keyboard('{End}')
    expect(third).toHaveFocus()
    await userEvent.keyboard('{ArrowRight}')
    expect(first).toHaveFocus()
    await userEvent.keyboard('{ArrowLeft}')
    expect(third).toHaveFocus()
    await userEvent.keyboard('{Home}')
    expect(first).toHaveFocus()
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Panneau a')
  })

  it('selects a tab on click', async () => {
    render(<Harness />)
    await userEvent.click(screen.getByRole('tab', { name: 'R2' }))
    expect(screen.getByRole('tab', { name: 'R2' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Panneau c')
  })
})
