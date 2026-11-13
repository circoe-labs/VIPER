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

describe('Menu submenu', () => {
  const onPick = vi.fn()
  function SubHarness() {
    return (
      <Menu
        label="Membre"
        position={{ x: 10, y: 10 }}
        onClose={vi.fn()}
        sections={[
          {
            items: [
              { id: 'a', label: 'Autre', onSelect: vi.fn() },
              {
                id: 'role',
                label: 'Rôle : Manager',
                onSelect: vi.fn(),
                submenu: {
                  label: 'Changer le rôle',
                  items: [
                    { id: 'admin', label: 'Administrateur', onSelect: onPick },
                    { id: 'manager', label: 'Manager', checked: true, onSelect: onPick },
                  ],
                },
              },
            ],
          },
        ]}
      />
    )
  }

  it('opens on hover after a short delay without taking focus, closes when leaving', async () => {
    render(<SubHarness />)
    const parent = screen.getByRole('menuitem', { name: 'Rôle : Manager' })
    expect(parent).toHaveAttribute('aria-expanded', 'false')

    await userEvent.hover(parent)

    expect(await screen.findByRole('menu', { name: 'Changer le rôle' })).toBeInTheDocument()
    expect(parent).toHaveAttribute('aria-expanded', 'true')
    expect(parent).not.toHaveFocus()
    await userEvent.hover(screen.getByRole('menuitem', { name: 'Autre' }))
    expect(screen.queryByRole('menu', { name: 'Changer le rôle' })).not.toBeInTheDocument()
  })

  it('opens with ArrowRight on the checked choice; ArrowLeft and Escape close only the submenu', async () => {
    render(<SubHarness />)
    await userEvent.keyboard('{ArrowDown}{ArrowRight}')

    expect(screen.getByRole('menuitemradio', { name: 'Manager' })).toHaveFocus()
    await userEvent.keyboard('{ArrowUp}')
    expect(screen.getByRole('menuitemradio', { name: 'Administrateur' })).toHaveFocus()
    await userEvent.keyboard('{ArrowLeft}')
    expect(screen.queryByRole('menu', { name: 'Changer le rôle' })).not.toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'Rôle : Manager' })).toHaveFocus()

    await userEvent.keyboard('{Enter}')
    expect(screen.getByRole('menuitemradio', { name: 'Manager' })).toHaveFocus()
    await userEvent.keyboard('{Escape}')
    expect(screen.getByRole('menu', { name: 'Membre' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'Rôle : Manager' })).toHaveFocus()
  })

  it('runs the chosen radio item', async () => {
    render(<SubHarness />)
    await userEvent.click(screen.getByRole('menuitem', { name: 'Rôle : Manager' }))
    await userEvent.click(screen.getByRole('menuitemradio', { name: 'Administrateur' }))
    expect(onPick).toHaveBeenCalledOnce()
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
