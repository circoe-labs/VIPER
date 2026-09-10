import { expect, type Page, test } from '@playwright/test'

import { openDatabase, SCREENSHOTS, useTheme } from './helpers'
import { signIn } from './session'

// Runs against the synthetic dataset loaded by global setup (backend/tests/fixtures/synthetic/explorer_dataset.py).

test.use({ viewport: { width: 1440, height: 900 } })

test.beforeEach(async ({ page }) => {
  await signIn(page)
})

function grid(page: Page, table: string) {
  return page.getByRole('grid', { name: `Lignes de ${table}` })
}

function status(page: Page) {
  return page.locator('.explorer-status__range')
}

test('pick a table, sort, filter and read a long value', async ({ page }) => {
  await openDatabase(page)
  const rail = page.getByRole('navigation', { name: 'Tables' })
  await expect(rail.getByRole('link', { name: /^companies/ })).toContainText('36')

  await rail.getByRole('link', { name: /^companies/ }).click()
  const companies = grid(page, 'companies')
  await expect(companies.getByRole('gridcell', { name: 'Transports Exemple SARL' })).toBeVisible()
  await expect(status(page)).toHaveText('Lignes 1–36 sur 36')

  await companies.getByRole('button', { name: 'display_name, non trié' }).click()
  await expect(page).toHaveURL(/sort=display_name/)
  await expect(companies.locator('tbody tr').first()).toContainText('Affrètement Démo SA')

  await companies.getByRole('button', { name: 'Filtrer display_name' }).click()
  const editor = page.getByRole('dialog', { name: 'Filtrer display_name' })
  await editor.getByLabel('Condition').selectOption('contains')
  await editor.getByLabel('Valeur').fill('fret')
  await editor.getByRole('button', { name: 'Ajouter le filtre' }).click()
  await expect(page.getByRole('group', { name: 'Critères actifs' })).toContainText('display_name contient « fret »')
  await expect(status(page)).toHaveText('Lignes 1–6 sur 6 (filtrées parmi 36)')

  await page.getByRole('button', { name: 'Effacer les filtres' }).click()
  await expect(status(page)).toHaveText('Lignes 1–36 sur 36')

  // Global search reaches long text columns too.
  await page.getByRole('searchbox', { name: 'Rechercher dans companies' }).fill('PARAGRAPHE fictif 8')
  await expect(status(page)).toHaveText('Lignes 1–1 sur 1 (filtrées parmi 36)')
  await companies.getByRole('gridcell', { name: /^Paragraphe fictif 1/ }).dblclick()
  const viewer = page.getByRole('dialog', { name: 'client_approach' })
  await expect(viewer.getByLabel('Valeur de client_approach')).toContainText('Paragraphe fictif 8')
  await page.keyboard.press('Escape')
  await expect(viewer).toBeHidden()
})

test('follow a foreign key from the context menu and come back', async ({ page }) => {
  await openDatabase(page, 'prospects')
  const prospects = grid(page, 'prospects')
  const firstRow = prospects.locator('tbody tr').first()
  await expect(firstRow).toContainText('Jean')

  // Cells after the row number: id (pinned), then company_id.
  await firstRow.getByRole('gridcell').nth(1).click({ button: 'right' })
  await page.getByRole('menuitem', { name: /Ouvrir la ligne référencée/ }).click()

  await expect(page).toHaveURL(/\/database\/companies\?filters=/)
  const companies = grid(page, 'companies')
  await expect(status(page)).toHaveText('Lignes 1–1 sur 1 (filtrées parmi 36)')
  await expect(companies.getByRole('gridcell', { name: 'Transports Exemple SARL' })).toBeVisible()

  await page.getByRole('button', { name: 'Retour à prospects' }).click()
  await expect(page).toHaveURL(/\/database\/prospects$/)
  await expect(grid(page, 'prospects')).toBeVisible()
})

test('keyboard: move between cells and open the context menu with Shift+F10', async ({ page }) => {
  await openDatabase(page, 'companies')
  const companies = grid(page, 'companies')
  const first = companies.getByRole('gridcell', { name: 'Transports Exemple SARL' })
  await first.click()
  await page.keyboard.press('ArrowDown')
  await expect(companies.getByRole('gridcell', { name: 'Logistique Exemple SAS' })).toBeFocused()

  await page.keyboard.press('Shift+F10')
  const menu = page.getByRole('menu', { name: 'Actions sur display_name' })
  await expect(menu.getByRole('menuitem', { name: 'Copier la valeur' })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(menu).toBeHidden()
  await expect(companies.getByRole('gridcell', { name: 'Logistique Exemple SAS' })).toBeFocused()
})

test('wide tables scroll inside the grid, never the page, at 1280 px', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await openDatabase(page, 'prospects')
  await expect(grid(page, 'prospects').locator('tbody tr').first()).toContainText('Jean')

  const overflow = await page.evaluate(() => ({
    page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    grid: (() => {
      const scroller = document.querySelector('.explorer-grid')
      return scroller ? scroller.scrollWidth - scroller.clientWidth : 0
    })(),
  }))
  expect(overflow.page).toBe(0)
  expect(overflow.grid).toBeGreaterThan(0)
  await page.screenshot({ path: `${SCREENSHOTS}/database-1280.png` })
})

for (const theme of ['dark', 'light'] as const) {
  test(`explorer screenshots (${theme})`, async ({ page }) => {
    await useTheme(page, theme)
    await openDatabase(page, 'prospects')
    await expect(grid(page, 'prospects').locator('tbody tr').first()).toContainText('Jean')
    await page.screenshot({ path: `${SCREENSHOTS}/database-${theme}.png` })

    await grid(page, 'prospects').locator('tbody tr').nth(2).getByRole('gridcell').nth(1).click({ button: 'right' })
    await expect(page.getByRole('menu')).toBeVisible()
    await page.screenshot({ path: `${SCREENSHOTS}/database-menu-${theme}.png`, animations: 'disabled' })
    await page.keyboard.press('Escape')

    await openDatabase(page, 'companies')
    await grid(page, 'companies').getByRole('gridcell', { name: /^Paragraphe fictif 1/ }).dblclick()
    await expect(page.getByRole('dialog', { name: 'client_approach' })).toContainText('Paragraphe fictif 8')
    await page.screenshot({ path: `${SCREENSHOTS}/database-viewer-${theme}.png`, animations: 'disabled' })
  })
}
