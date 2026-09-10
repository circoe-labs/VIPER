import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'

import { Combobox, type ComboboxCreate, type ComboboxOption } from './Combobox'

const OPTIONS: ComboboxOption[] = [
  { id: 'r1', label: 'Dirigeant' },
  { id: 'r2', label: 'Écrivain public', hint: 'rarement utilisé' },
  { id: 'r3', label: 'Responsable transport' },
  { id: 'r4', label: 'Ancien rôle', inactive: true },
]

function Single({
  initial = null,
  create,
  onChange = () => undefined,
}: {
  initial?: string | null
  create?: ComboboxCreate
  onChange?: (value: string | null) => void
}) {
  const [value, setValue] = useState<string | null>(initial)
  const [options, setOptions] = useState(OPTIONS)
  const creation = create && {
    ...create,
    run: async (text: string) => {
      const option = await create.run(text)
      setOptions((current) => [...current, option])
      return option
    },
  }
  return (
    <Combobox
      label="Rôle"
      options={options}
      value={value}
      create={creation}
      onChange={(next) => {
        setValue(next)
        onChange(next)
      }}
    />
  )
}

function Multi({ initial = [] }: { initial?: string[] }) {
  const [value, setValue] = useState<string[]>(initial)
  return <Combobox multiple label="Catégories" options={OPTIONS} value={value} onChange={setValue} />
}

const input = () => screen.getByRole('combobox', { name: 'Rôle' })
const optionNames = () => screen.getAllByRole('option').map((option) => option.textContent)

describe('Combobox', () => {
  it('opens with ArrowDown, moves with the arrows and picks with Enter', async () => {
    const onChange = vi.fn()
    render(<Single onChange={onChange} />)

    await userEvent.click(input())
    expect(input()).toHaveAttribute('aria-expanded', 'true')
    await userEvent.keyboard('{Escape}')
    expect(input()).toHaveAttribute('aria-expanded', 'false')

    await userEvent.keyboard('{ArrowDown}')
    expect(screen.getByRole('listbox', { name: 'Rôle' })).toBeInTheDocument()
    expect(input()).toHaveAttribute('aria-activedescendant', screen.getAllByRole('option')[0]?.id)
    await userEvent.keyboard('{ArrowDown}{ArrowDown}{ArrowUp}{Enter}')

    expect(onChange).toHaveBeenCalledWith('r2')
    expect(input()).toHaveValue('Écrivain public')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })

  it('filters ignoring case and accents, word by word, and hides inactive values', async () => {
    render(<Single />)

    await userEvent.click(input())
    expect(optionNames()).toEqual(['Dirigeant', 'Écrivain publicrarement utilisé', 'Responsable transport'])

    await userEvent.type(input(), 'ECRIV pub')
    expect(optionNames()).toEqual(['Écrivain publicrarement utilisé'])

    await userEvent.clear(input())
    await userEvent.type(input(), 'zzz')
    expect(screen.getByText('Aucun résultat.')).toBeInTheDocument()
  })

  it('keeps an inactive value visible while it is selected', async () => {
    render(<Single initial="r4" />)

    expect(input()).toHaveValue('Ancien rôle')
    await userEvent.keyboard('{Tab}')
    await userEvent.click(input())
    const selected = screen.getByRole('option', { selected: true })
    expect(selected).toHaveTextContent('Ancien rôle')
    expect(within(selected).getByText('Inactif')).toBeInTheDocument()
  })

  it('explains that a typed value exists but is deactivated', async () => {
    render(<Single create={{ run: vi.fn() }} />)

    await userEvent.type(input(), 'ancien ROLE')

    expect(screen.queryByRole('option')).not.toBeInTheDocument()
    expect(screen.getByText(/« Ancien rôle » existe mais est désactivé/)).toBeInTheDocument()
  })

  it('creates a missing value inline and selects it', async () => {
    const run = vi.fn((text: string) => Promise.resolve({ id: 'new', label: text }))
    const onChange = vi.fn()
    render(<Single create={{ run }} onChange={onChange} />)

    await userEvent.type(input(), 'Directeur des achats')
    expect(optionNames()).toEqual(['Créer « Directeur des achats »'])
    await userEvent.keyboard('{Enter}')

    expect(run).toHaveBeenCalledWith('Directeur des achats')
    expect(onChange).toHaveBeenCalledWith('new')
    expect(input()).toHaveValue('Directeur des achats')
  })

  it('offers no creation for a text an option already carries', async () => {
    render(<Single create={{ run: vi.fn() }} />)

    await userEvent.type(input(), '  dirigeant ')

    expect(optionNames()).toEqual(['Dirigeant'])
  })

  it('offers no creation while the list is loading, so Enter cannot duplicate a value not yet shown', async () => {
    const run = vi.fn()
    const { rerender } = render(<Combobox label="Rôle" options={[]} status="loading" value={null} create={{ run }} onChange={vi.fn()} />)

    await userEvent.type(input(), 'dirig{Enter}')

    expect(screen.queryByRole('option')).not.toBeInTheDocument()
    expect(screen.getByText('Chargement…')).toBeInTheDocument()
    expect(run).not.toHaveBeenCalled()
    rerender(<Combobox label="Rôle" options={OPTIONS} status="ready" value={null} create={{ run }} onChange={vi.fn()} />)
    expect(optionNames()).toEqual(['Dirigeant', 'Créer « dirig »'])
  })

  it('shows why a creation failed under the field', async () => {
    const run = vi.fn(() => Promise.reject(new Error('« Directeur » existe déjà.')))
    render(<Single create={{ run }} />)

    await userEvent.type(input(), 'Directeur')
    await userEvent.click(screen.getByRole('option', { name: 'Créer « Directeur »' }))

    expect(await screen.findByText('« Directeur » existe déjà.')).toBeInTheDocument()
    expect(input()).toHaveAttribute('aria-invalid', 'true')
  })

  it('shows a refusal instead of the creation option when the text cannot be created', async () => {
    render(<Single create={{ run: vi.fn(), refuse: () => 'Saisissez le prénom puis le nom.' }} />)

    await userEvent.type(input(), 'Marie')

    expect(screen.queryByRole('option', { name: /Créer/ })).not.toBeInTheDocument()
    expect(screen.getByText('Saisissez le prénom puis le nom.')).toBeInTheDocument()
  })

  it('clears a single value with the clear button', async () => {
    const onChange = vi.fn()
    render(<Single initial="r1" onChange={onChange} />)

    await userEvent.click(screen.getByRole('button', { name: 'Effacer « Dirigeant »' }))

    expect(onChange).toHaveBeenCalledWith(null)
    expect(input()).toHaveValue('')
  })

  it('keeps Escape from closing an enclosing dialog while the list is open', async () => {
    const outer = vi.fn()
    render(
      <div onKeyDown={outer}>
        <Single />
      </div>,
    )

    await userEvent.click(input())
    await userEvent.keyboard('{Escape}')
    expect(outer).not.toHaveBeenCalled()

    await userEvent.keyboard('{Escape}')
    expect(outer).toHaveBeenCalledTimes(1)
  })

  it('toggles several values, shows them as chips and removes them', async () => {
    render(<Multi initial={['r4']} />)
    const multi = screen.getByRole('combobox', { name: 'Catégories' })

    expect(screen.getByText('Ancien rôle')).toBeInTheDocument()
    await userEvent.click(multi)
    expect(screen.getByRole('listbox')).toHaveAttribute('aria-multiselectable', 'true')
    await userEvent.keyboard('{ArrowDown}{Enter}{ArrowDown}{Enter}')

    expect(screen.getAllByRole('option', { selected: true }).map((option) => option.textContent)).toEqual([
      'Dirigeant',
      'Écrivain publicrarement utilisé',
      'Ancien rôleInactif',
    ])
    await userEvent.click(screen.getByRole('button', { name: 'Retirer « Dirigeant »' }))
    await userEvent.keyboard('{Backspace}')

    expect(screen.queryByRole('button', { name: /Retirer « Écrivain public »/ })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Retirer « Ancien rôle »' })).toBeInTheDocument()
  })
})
