import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'

import { AccentPicker } from './AccentPicker'

afterEach(() => {
  delete document.documentElement.dataset.accent
  window.localStorage.removeItem('viper.accent')
})

describe('AccentPicker', () => {
  it('applies the chosen accent to the page and remembers it', async () => {
    render(<AccentPicker />)

    await userEvent.click(screen.getByRole('radio', { name: 'Violet' }))

    expect(document.documentElement.dataset.accent).toBe('violet')
    expect(window.localStorage.getItem('viper.accent')).toBe('violet')
    expect(screen.getByRole('radio', { name: 'Violet' })).toBeChecked()
  })
})
