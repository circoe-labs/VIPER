import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useRef, useState } from 'react'
import { describe, expect, it, vi } from 'vitest'

import { Button } from './Button'
import { Drawer, Modal } from './Dialog'
import { TextField } from './fields'

function ModalHarness({ onClose = vi.fn() }: { onClose?: () => void }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button
        onClick={() => {
          setOpen(true)
        }}
      >
        Ouvrir
      </Button>
      <Modal
        open={open}
        onClose={() => {
          onClose()
          setOpen(false)
        }}
        title="Confirmer"
        description="Action définitive."
        footer={<Button variant="danger">Supprimer</Button>}
      >
        <TextField label="Motif" />
      </Modal>
    </>
  )
}

describe('Modal', () => {
  it('renders nothing while closed', () => {
    render(<Modal open={false} onClose={vi.fn()} title="Confirmer">contenu</Modal>)

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('is a labelled, described modal dialog that receives focus', async () => {
    render(<ModalHarness />)
    await userEvent.click(screen.getByRole('button', { name: 'Ouvrir' }))

    const dialog = screen.getByRole('dialog', { name: 'Confirmer' })
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    expect(dialog).toHaveAccessibleDescription('Action définitive.')
    expect(dialog).toHaveFocus()
  })

  it('traps Tab and Shift+Tab inside the dialog', async () => {
    render(<ModalHarness />)
    await userEvent.click(screen.getByRole('button', { name: 'Ouvrir' }))
    const close = screen.getByRole('button', { name: 'Fermer' })
    const field = screen.getByRole('textbox', { name: 'Motif' })
    const last = screen.getByRole('button', { name: 'Supprimer' })

    await userEvent.tab()
    expect(close).toHaveFocus()
    await userEvent.tab()
    expect(field).toHaveFocus()
    await userEvent.tab()
    expect(last).toHaveFocus()
    await userEvent.tab()
    expect(close).toHaveFocus()
    await userEvent.tab({ shift: true })
    expect(last).toHaveFocus()
  })

  it('closes on Escape and returns focus to the trigger', async () => {
    const onClose = vi.fn()
    render(<ModalHarness onClose={onClose} />)
    const trigger = screen.getByRole('button', { name: 'Ouvrir' })
    await userEvent.click(trigger)

    await userEvent.keyboard('{Escape}')

    expect(onClose).toHaveBeenCalledOnce()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
    expect(document.body.style.overflow).toBe('')
  })

  it('closes from the close button', async () => {
    const onClose = vi.fn()
    render(<ModalHarness onClose={onClose} />)
    await userEvent.click(screen.getByRole('button', { name: 'Ouvrir' }))

    await userEvent.click(screen.getByRole('button', { name: 'Fermer' }))

    expect(onClose).toHaveBeenCalledOnce()
  })
})

describe('Drawer', () => {
  function EditorHarness({ onCloseOuter }: { onCloseOuter: () => void }) {
    const firstField = useRef<HTMLInputElement>(null)
    const [nestedOpen, setNestedOpen] = useState(false)
    return (
      <Drawer open onClose={onCloseOuter} title="Prospect" initialFocusRef={firstField} size="xl">
        <TextField ref={firstField} label="Prénom" />
        <Button
          onClick={() => {
            setNestedOpen(true)
          }}
        >
          Ouvrir l’entreprise
        </Button>
        <Modal
          open={nestedOpen}
          onClose={() => {
            setNestedOpen(false)
          }}
          title="Entreprise"
        >
          <TextField label="Raison sociale" />
        </Modal>
      </Drawer>
    )
  }

  it('focuses the requested field on open', () => {
    render(<EditorHarness onCloseOuter={vi.fn()} />)

    expect(screen.getByRole('dialog', { name: 'Prospect' })).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Prénom' })).toHaveFocus()
  })

  it('closes only the topmost dialog on Escape', async () => {
    const onCloseOuter = vi.fn()
    render(<EditorHarness onCloseOuter={onCloseOuter} />)
    const opener = screen.getByRole('button', { name: 'Ouvrir l’entreprise' })
    await userEvent.click(opener)
    expect(screen.getByRole('dialog', { name: 'Entreprise' })).toHaveFocus()

    await userEvent.keyboard('{Escape}')

    expect(screen.queryByRole('dialog', { name: 'Entreprise' })).not.toBeInTheDocument()
    expect(screen.getByRole('dialog', { name: 'Prospect' })).toBeInTheDocument()
    expect(onCloseOuter).not.toHaveBeenCalled()
    expect(opener).toHaveFocus()

    await userEvent.keyboard('{Escape}')
    expect(onCloseOuter).toHaveBeenCalledOnce()
  })
})

describe('Focus loss inside a dialog', () => {
  // An editor whose save button is disabled while saving and stays so once saved (nothing left to save).
  function SavingEditor({ onClose }: { onClose: () => void }) {
    const [saved, setSaved] = useState(false)
    const [nestedOpen, setNestedOpen] = useState(false)
    const [extraAction, setExtraAction] = useState(true)
    return (
      <Drawer
        open
        onClose={onClose}
        title="Entreprise"
        footer={
          <Button
            disabled={saved}
            onClick={() => {
              setSaved(true)
            }}
          >
            Enregistrer
          </Button>
        }
      >
        {extraAction && (
          <Button
            onClick={() => {
              setExtraAction(false)
            }}
          >
            Retirer cette action
          </Button>
        )}
        <Button
          onClick={() => {
            setNestedOpen(true)
          }}
        >
          Confirmer
        </Button>
        <Modal
          open={nestedOpen}
          onClose={() => {
            setNestedOpen(false)
          }}
          title="Abandonner ?"
        >
          <p>Modifications perdues.</p>
        </Modal>
      </Drawer>
    )
  }

  it('moves focus to the dialog when the focused button gets disabled, so Esc still closes it', async () => {
    const onClose = vi.fn()
    render(<SavingEditor onClose={onClose} />)
    const dialog = screen.getByRole('dialog', { name: 'Entreprise' })

    await userEvent.click(screen.getByRole('button', { name: 'Enregistrer' }))

    expect(screen.getByRole('button', { name: 'Enregistrer' })).toBeDisabled()
    await waitFor(() => {
      expect(dialog).toHaveFocus()
    })
    await userEvent.tab()
    expect(dialog).toContainElement(document.activeElement as HTMLElement)
    await userEvent.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('moves focus to the dialog when the focused button is removed', async () => {
    render(<SavingEditor onClose={vi.fn()} />)
    const dialog = screen.getByRole('dialog', { name: 'Entreprise' })

    await userEvent.click(screen.getByRole('button', { name: 'Retirer cette action' }))

    expect(screen.queryByRole('button', { name: 'Retirer cette action' })).not.toBeInTheDocument()
    await waitFor(() => {
      expect(dialog).toHaveFocus()
    })
  })

  it('closes the top dialog on Esc even when focus is outside every dialog', async () => {
    const onClose = vi.fn()
    render(<SavingEditor onClose={onClose} />)
    await userEvent.click(screen.getByRole('button', { name: 'Confirmer' }))
    const nested = screen.getByRole('dialog', { name: 'Abandonner ?' })
    expect(nested).toHaveFocus()

    // What a browser does when the focused element vanishes without the dialog noticing.
    nested.blur()
    expect(document.body).toHaveFocus()
    await userEvent.keyboard('{Escape}')

    expect(screen.queryByRole('dialog', { name: 'Abandonner ?' })).not.toBeInTheDocument()
    expect(onClose).not.toHaveBeenCalled()
    ;(document.activeElement as HTMLElement).blur()
    await userEvent.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('leaves an Esc already handled elsewhere alone', async () => {
    const onClose = vi.fn()
    render(<SavingEditor onClose={onClose} />)
    screen.getByRole('dialog', { name: 'Entreprise' }).blur()
    document.body.addEventListener('keydown', (event) => {
      event.preventDefault()
    }, { once: true })

    await userEvent.keyboard('{Escape}')

    expect(onClose).not.toHaveBeenCalled()
  })
})
