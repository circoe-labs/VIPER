import { createContext, use } from 'react'

import { readStorage } from '../lib/storage'

export type Theme = 'dark' | 'light'

// Keep in sync with the pre-paint script in index.html.
export const THEME_STORAGE_KEY = 'viper.theme'

// Dark is the authored Neon Command theme: without an explicit stored choice the app is dark, whatever the OS says.
export function readStoredTheme(): Theme {
  const stored = readStorage(THEME_STORAGE_KEY)
  return stored === 'light' ? 'light' : 'dark'
}

export interface ThemeContextValue {
  theme: Theme
  setTheme: (theme: Theme) => void
}

export const ThemeContext = createContext<ThemeContextValue | null>(null)

export function useTheme(): ThemeContextValue {
  const context = use(ThemeContext)
  if (!context) throw new Error('useTheme must be used inside <ThemeProvider>')
  return context
}
