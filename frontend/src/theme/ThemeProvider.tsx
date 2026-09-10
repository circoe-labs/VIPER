import { type ReactNode, useLayoutEffect, useMemo, useState } from 'react'

import { writeStorage } from '../lib/storage'
import { readStoredTheme, type Theme, ThemeContext, THEME_STORAGE_KEY } from './theme'

// Owns the active theme, mirrors it on <html data-theme> (tokens.css keys off it) and persists explicit choices.
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(readStoredTheme)

  useLayoutEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])

  const value = useMemo(
    () => ({
      theme,
      setTheme: (next: Theme) => {
        writeStorage(THEME_STORAGE_KEY, next)
        setThemeState(next)
      },
    }),
    [theme],
  )

  return <ThemeContext value={value}>{children}</ThemeContext>
}
