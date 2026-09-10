import { render, screen } from '@testing-library/react'
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
