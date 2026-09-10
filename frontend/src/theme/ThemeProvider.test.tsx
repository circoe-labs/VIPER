import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { renderApp, stubFetchJson } from '../test/render'
import { THEME_STORAGE_KEY, useTheme } from './theme'

function renderShell() {
  stubFetchJson(200, { status: 'ok', database: 'ok' })
  return renderApp()
}

describe('ThemeProvider', () => {
  it('defaults to the dark theme without a stored choice', () => {
    renderShell()

    expect(document.documentElement).toHaveAttribute('data-theme', 'dark')
    expect(screen.getByRole('button', { name: 'Passer au thème clair' })).toBeInTheDocument()
  })

  it('switches theme, persists the choice and restores it on the next visit', async () => {
    const { unmount } = renderShell()

    await userEvent.click(screen.getByRole('button', { name: 'Passer au thème clair' }))

    expect(document.documentElement).toHaveAttribute('data-theme', 'light')
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('light')
    expect(screen.getByRole('button', { name: 'Passer au thème sombre' })).toBeInTheDocument()

    unmount()
    delete document.documentElement.dataset.theme
    renderShell()

    expect(document.documentElement).toHaveAttribute('data-theme', 'light')
  })

  it('falls back to dark when the stored value is not a known theme', () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, 'neon')
    renderShell()

    expect(document.documentElement).toHaveAttribute('data-theme', 'dark')
  })

  it('refuses to be used outside the provider', () => {
    function Orphan() {
      useTheme()
      return null
    }
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    expect(() => render(<Orphan />)).toThrow('useTheme must be used inside <ThemeProvider>')
  })
})
