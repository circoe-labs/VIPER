import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import { Checkbox, SelectField, Switch, TextAreaField, TextField } from './fields'

describe('fields', () => {
  it('binds the label and describes the control with its hint', () => {
    render(<TextField label="Nom" hint="Tel qu’indiqué sur la carte." required />)

    const input = screen.getByRole('textbox', { name: 'Nom' })
    expect(input).toBeRequired()
    expect(input).toHaveAccessibleDescription('Tel qu’indiqué sur la carte.')
    expect(input).not.toHaveAttribute('aria-invalid')
  })

  it('announces errors as invalid state plus visible text', () => {
    render(<TextField label="Adresse e-mail" hint="Adresse principale." error="Adresse e-mail invalide." />)

    const input = screen.getByRole('textbox', { name: 'Adresse e-mail' })
    expect(input).toHaveAttribute('aria-invalid', 'true')
    expect(input).toHaveAccessibleDescription('Adresse principale. Adresse e-mail invalide.')
    expect(screen.getByText('Adresse e-mail invalide.')).toBeVisible()
  })

  it('shows a warning without marking the control invalid, and an error instead of it', () => {
    const { rerender } = render(<TextField label="SIRET" warning="Ne commence pas par le SIREN." />)

    const input = screen.getByRole('textbox', { name: 'SIRET' })
    expect(input).not.toHaveAttribute('aria-invalid')
    expect(input).toHaveAccessibleDescription('Ne commence pas par le SIREN.')

    rerender(<TextField label="SIRET" warning="Ne commence pas par le SIREN." error="14 chiffres." />)
    expect(input).toHaveAccessibleDescription('14 chiffres.')
    expect(screen.queryByText('Ne commence pas par le SIREN.')).not.toBeInTheDocument()
  })

  it('keeps a caller-provided description id', () => {
    render(
      <>
        <p id="external">Aide externe.</p>
        <TextField label="Code" aria-describedby="external" hint="Aide interne." />
      </>,
    )

    expect(screen.getByRole('textbox', { name: 'Code' })).toHaveAccessibleDescription('Aide externe. Aide interne.')
  })

  it('labels textareas and selects', async () => {
    render(
      <>
        <TextAreaField label="Note" />
        <SelectField label="Choix" defaultValue="a">
          <option value="a">Option A</option>
          <option value="b">Option B</option>
        </SelectField>
      </>,
    )

    await userEvent.type(screen.getByRole('textbox', { name: 'Note' }), 'Bonjour')
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Choix' }), 'b')

    expect(screen.getByRole('textbox', { name: 'Note' })).toHaveValue('Bonjour')
    expect(screen.getByRole('combobox', { name: 'Choix' })).toHaveValue('b')
  })

  it('toggles checkboxes and switches through their labels', async () => {
    render(
      <>
        <Checkbox label="Principal" />
        <Switch label="Ne pas contacter" hint="Protection durable." />
      </>,
    )

    await userEvent.click(screen.getByText('Principal'))
    await userEvent.click(screen.getByText('Ne pas contacter'))

    expect(screen.getByRole('checkbox', { name: 'Principal' })).toBeChecked()
    const toggle = screen.getByRole('switch', { name: 'Ne pas contacter' })
    expect(toggle).toBeChecked()
    expect(toggle).toHaveAccessibleDescription('Protection durable.')
  })
})
