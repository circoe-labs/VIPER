import { expect, type Locator, type Page } from '@playwright/test'

// Screenshots for design review land in the git-ignored test-results/ folder (recreated on every run).
export const SCREENSHOTS = 'test-results/screenshots'

// Opens the Database explorer (optionally on one table). The page must be signed in first (`signIn`, session.ts).
export async function openDatabase(page: Page, table?: string) {
  await page.goto(table ? `/database/${table}` : '/database')
  await expect(page.getByRole('heading', { level: 1, name: 'Base de données' })).toBeVisible()
}

// Types `text` in the picker `label` and takes the first suggestion with Enter, once that is `option`: the values load
// asynchronously, and Enter must not act on a list that is still loading.
export async function pickFirst(scope: Page | Locator, label: string, text: string, option: string) {
  const picker = scope.getByRole('combobox', { name: label, exact: true })
  await picker.fill(text)
  await expect(scope.getByRole('listbox', { name: label, exact: true }).getByRole('option').first()).toHaveText(option)
  await picker.press('Enter')
}

export async function useTheme(page: Page, theme: 'dark' | 'light') {
  await page.addInitScript((value) => {
    window.localStorage.setItem('viper.theme', value)
  }, theme)
}
