import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'

import { Button } from './Button'
import { Menu } from './Menu'
import { Popover } from './Popover'

function MenuHarness({ onCopy = vi.fn() }: { onCopy?: () => void }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button
        onClick={() => {
          setOpen(true)
        }}
      >
        Actions
      </Button>
      {open && (
        <Menu
          label="Actions sur la cellule"
          position={{ x: 10, y: 10 }}
          onClose={() => {
            setOpen(false)
          }}
          sections={[
            { label: 'Cellule', items: [{ id: 'copy', label: 'Copier', onSelect: onCopy }] },
            {
              label: 'Filtre',
              items: [
                { id: 'off', label: 'Indisponible', disabled: true, onSelect: vi.fn() },
                { id: 'filter', label: 'Filtrer', onSelect: vi.fn() },
              ],
            },
          ]}
        />
      )}
    </>
  )
}

describe('Menu', () => {
  it('is a labelled menu whose first item takes focus; arrows skip disabled items and wrap', async () => {
    render(<MenuHarness />)
    await userEvent.click(screen.getByRole('button', { name: 'Actions' }))

    expect(screen.getByRole('menu', { name: 'Actions sur la cellule' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'Copier' })).toHaveFocus()
    await userEvent.keyboard('{ArrowDown}')
    expect(screen.getByRole('menuitem', { name: 'Filtrer' })).toHaveFocus()
    await userEvent.keyboard('{ArrowDown}')
    expect(screen.getByRole('menuitem', { name: 'Copier' })).toHaveFocus()
    await userEvent.keyboard('{End}')
    expect(screen.getByRole('menuitem', { name: 'Filtrer' })).toHaveFocus()
  })

  it('runs the chosen item, closes and gives focus back', async () => {
    const onCopy = vi.fn()
    render(<MenuHarness onCopy={onCopy} />)
    await userEvent.click(screen.getByRole('button', { name: 'Actions' }))

    await userEvent.keyboard('{Enter}')

    expect(onCopy).toHaveBeenCalledOnce()
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Actions' })).toHaveFocus()
  })

  it('closes on Escape and on an outside press', async () => {
    render(<MenuHarness />)
    await userEvent.click(screen.getByRole('button', { name: 'Actions' }))
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Actions' })).toHaveFocus()

    await userEvent.click(screen.getByRole('button', { name: 'Actions' }))
    await userEvent.click(document.body)
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })
})

describe('Popover', () => {
  it('focuses its first field and closes on Escape, restoring focus', async () => {
    function Harness() {
      const [anchor, setAnchor] = useState<HTMLElement | null>(null)
      return (
        <>
          <Button
            onClick={(event) => {
              setAnchor(event.currentTarget)
            }}
          >
            Colonnes
          </Button>
          {anchor && (
            <Popover
              anchor={anchor}
              label="Colonnes affichées"
              onClose={() => {
                setAnchor(null)
              }}
            >
              <input aria-label="Nom" />
            </Popover>
          )}
        </>
      )
    }
    render(<Harness />)
    await userEvent.click(screen.getByRole('button', { name: 'Colonnes' }))

    expect(screen.getByRole('dialog', { name: 'Colonnes affichées' })).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Nom' })).toHaveFocus()
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Colonnes' })).toHaveFocus()
  })
})
