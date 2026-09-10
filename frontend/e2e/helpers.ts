import { expect, type Page } from '@playwright/test'

// Screenshots for design review land in the git-ignored test-results/ folder (recreated on every run).
export const SCREENSHOTS = 'test-results/screenshots'

// Opens the Database explorer (optionally on one table). Once authentication exists (Task 04), the login step
// belongs here so every explorer scenario keeps a single entry point.
export async function openDatabase(page: Page, table?: string) {
  await page.goto(table ? `/database/${table}` : '/database')
  await expect(page.getByRole('heading', { level: 1, name: 'Base de données' })).toBeVisible()
}

export async function useTheme(page: Page, theme: 'dark' | 'light') {
  await page.addInitScript((value) => {
    window.localStorage.setItem('viper.theme', value)
  }, theme)
}
