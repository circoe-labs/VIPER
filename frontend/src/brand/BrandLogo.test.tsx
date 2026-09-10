import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { THEME_STORAGE_KEY } from '../theme/theme'
import { ThemeProvider } from '../theme/ThemeProvider'
import { BrandLogo } from './BrandLogo'
import { type LogoVariant, logoSource } from './logos'

describe('logoSource', () => {
  it.each([
    ['mark', 'dark', 'viper-mark-white.png'],
    ['mark', 'light', 'viper-mark-black.png'],
    ['lockup', 'dark', 'viper-lockup-white.png'],
    ['lockup', 'light', 'viper-lockup-black.png'],
    ['accent', 'dark', 'viper-mark-neon-green-black.png'],
    ['accent', 'light', 'viper-mark-black-neon-green.png'],
  ] as const)('%s on the %s theme uses %s', (variant, theme, file) => {
    expect(logoSource(variant, theme)).toMatch(new RegExp(`/${file.replace('.', '\\.')}$`))
  })

  it('uses all six accepted files', () => {
    const variants: LogoVariant[] = ['mark', 'lockup', 'accent']
    const files = variants.flatMap((variant) => [logoSource(variant, 'dark'), logoSource(variant, 'light')])
    expect(new Set(files).size).toBe(6)
  })
})

describe('BrandLogo', () => {
  it('follows the active theme and names the brand', () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, 'light')
    render(
      <ThemeProvider>
        <BrandLogo variant="lockup" height="3rem" />
      </ThemeProvider>,
    )

    const logo = screen.getByRole('img', { name: 'VIPER' })
    expect(logo).toHaveAttribute('src', expect.stringMatching(/viper-lockup-black\.png$/))
    expect(logo).toHaveStyle({ height: '3rem' })
  })

  it('is hidden from assistive technologies when decorative', () => {
    render(
      <ThemeProvider>
        <BrandLogo variant="mark" height="2rem" decorative />
      </ThemeProvider>,
    )

    expect(screen.queryByRole('img', { name: 'VIPER' })).not.toBeInTheDocument()
    expect(document.querySelector('img')).toHaveAttribute('alt', '')
  })
})
