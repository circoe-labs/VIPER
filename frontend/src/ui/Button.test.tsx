import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { Button, IconButton } from './Button'
import { CloseIcon, PlusIcon } from './icons'

describe('Button', () => {
  it('is a non-submitting button by default and keeps its text as accessible name', async () => {
    const onClick = vi.fn()
    render(
      <Button variant="primary" icon={PlusIcon} onClick={onClick}>
        Ajouter
      </Button>,
    )

    const button = screen.getByRole('button', { name: 'Ajouter' })
    expect(button).toHaveAttribute('type', 'button')
    expect(button).toHaveClass('btn--primary')
    await userEvent.click(button)
    expect(onClick).toHaveBeenCalledOnce()
  })

  it('is busy and inert while loading', async () => {
    const onClick = vi.fn()
    render(
      <Button loading onClick={onClick}>
        Enregistrer
      </Button>,
    )

    const button = screen.getByRole('button', { name: 'Enregistrer' })
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute('aria-busy', 'true')
    await userEvent.click(button)
    expect(onClick).not.toHaveBeenCalled()
  })

  it('can submit a form when asked explicitly', () => {
    render(<Button type="submit">Valider</Button>)

    expect(screen.getByRole('button', { name: 'Valider' })).toHaveAttribute('type', 'submit')
  })
})

describe('IconButton', () => {
  it('takes its accessible name and tooltip from the mandatory label', () => {
    render(<IconButton icon={CloseIcon} label="Fermer" />)

    const button = screen.getByRole('button', { name: 'Fermer' })
    expect(button).toHaveAttribute('title', 'Fermer')
    expect(button.querySelector('svg')).toHaveAttribute('aria-hidden', 'true')
  })
})
