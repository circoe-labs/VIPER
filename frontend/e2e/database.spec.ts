import { expect, type Page, test } from '@playwright/test'

import { openDatabase, SCREENSHOTS, useTheme } from './helpers'
import { signIn } from './session'

// Runs against the synthetic dataset loaded by global setup (backend/tests/fixtures/synthetic/explorer_dataset.py),
// read-only for every spec. Other tests add rows at the same time (companies, referents, audit events), after the
// synthetic ones in primary-key order: exact counts and orderings are asserted on synthetic subsets picked by a filter
// or a search; the count of a whole table is compared with the API answer the page displays, never with a number
// known in advance or read at another moment.

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

const COUNT = new Intl.NumberFormat('fr-FR')

// "(filtrées parmi N)" with any N: the total depends on what other tests created.
const AMONG_ALL = String.raw`\(filtrées parmi [\d\s\u202f]+\)`

// The JSON answer to the GET of `path` (any query string) that `action` makes the page send: what it then displays.
async function answer<T>(page: Page, path: string, action: () => Promise<unknown>): Promise<T> {
  const [response] = await Promise.all([
    page.waitForResponse((candidate) => candidate.request().method() === 'GET' && new URL(candidate.url()).pathname === path),
    action(),
  ])
  expect(response.ok()).toBe(true)
  return (await response.json()) as T
}

interface RowPage {
  total: number
  rows: unknown[]
}

// Adds a column filter through the column header's filter editor.
async function addFilter(page: Page, table: string, column: string, operator: 'contains' | 'starts_with', value: string) {
  await grid(page, table).getByRole('button', { name: `Filtrer ${column}` }).click()
  const editor = page.getByRole('dialog', { name: `Filtrer ${column}` })
  await editor.getByLabel('Condition').selectOption(operator)
  await editor.getByLabel('Valeur').fill(value)
  await editor.getByRole('button', { name: 'Ajouter le filtre' }).click()
}

// Status line of the first page of `answer`.
function range({ total, rows }: RowPage): string {
  return `Lignes 1–${COUNT.format(rows.length)} sur ${COUNT.format(total)}`
}

test('pick a table, filter, sort and read a long value', async ({ page }) => {
  const tables = await answer<{ name: string; row_count: number }[]>(page, '/api/explorer/tables', () => openDatabase(page))
  const rail = page.getByRole('navigation', { name: 'Tables' })
  const listed = tables.find((table) => table.name === 'companies')
  await expect(rail.getByRole('link', { name: /^companies/ })).toContainText(COUNT.format(listed?.row_count ?? -1))

  const rowsPath = '/api/explorer/tables/companies/rows'
  const firstPage = await answer<RowPage>(page, rowsPath, () => rail.getByRole('link', { name: /^companies/ }).click())
  const companies = grid(page, 'companies')
  await expect(companies.getByRole('gridcell', { name: 'Transports Exemple SARL' })).toBeVisible()
  await expect(status(page)).toHaveText(range(firstPage))

  // The six synthetic "Fret …" companies: other tests may create companies named "Fret …" too, so the second filter
  // keeps the synthetic dataset only (its e-mail domains).
  await addFilter(page, 'companies', 'display_name', 'contains', 'fret')
  await addFilter(page, 'companies', 'email_domain', 'starts_with', 'societe')
  const criteria = page.getByRole('group', { name: 'Critères actifs' })
  await expect(criteria).toContainText('display_name contient « fret »')
  await expect(criteria).toContainText('email_domain commence par « societe »')
  await expect(status(page)).toHaveText(new RegExp(`^Lignes 1–6 sur 6 ${AMONG_ALL}$`))

  await companies.getByRole('button', { name: 'display_name, non trié' }).click()
  await expect(page).toHaveURL(/sort=display_name/)
  const sorted = ['Fret Démo SAS', 'Fret Essai SAS', 'Fret Exemple SAS', 'Fret Fictif SAS', 'Fret Modèle SAS', 'Fret Test SAS']
  const rows = companies.locator('tbody tr')
  await expect(rows).toHaveCount(sorted.length)
  for (const [index, name] of sorted.entries()) {
    await expect(rows.nth(index).getByRole('gridcell', { name, exact: true })).toBeVisible()
  }

  const cleared = await answer<RowPage>(page, rowsPath, () => page.getByRole('button', { name: 'Effacer les filtres' }).click())
  await expect(status(page)).toHaveText(range(cleared))

  // Global search reaches long text columns too.
  await page.getByRole('searchbox', { name: 'Rechercher dans companies' }).fill('PARAGRAPHE fictif 8')
  await expect(status(page)).toHaveText(new RegExp(`^Lignes 1–1 sur 1 ${AMONG_ALL}$`))
  // Double-click edits an editable cell (Task 12): the cell's expand button opens the full value.
  await companies.getByRole('gridcell', { name: /^Paragraphe fictif 1/ }).getByRole('button', { name: 'Voir la valeur complète' }).click()
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
  await expect(status(page)).toHaveText(new RegExp(`^Lignes 1–1 sur 1 ${AMONG_ALL}$`))
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

test('audit events are read-only rows whose JSON changes open pretty-printed', async ({ page }) => {
  // The creation events of the 36 synthetic companies, written by the dataset loader (other specs add their own).
  const companyEvents = encodeURIComponent(
    JSON.stringify([
      { column: 'entity_type', operator: 'eq', value: 'company' },
      { column: 'actor_id', operator: 'eq', value: 'tests.e2e_data' },
    ]),
  )
  await page.goto(`/database/audit_log?filters=${companyEvents}`)
  const events = grid(page, 'audit_log')
  await expect(status(page)).toContainText('Lignes 1–36 sur 36 (filtrées parmi')

  // A company creation lists every field: its `changes` preview is cut and the viewer loads the full JSONB value.
  await events.locator('td[data-kind="json"]').first().dblclick()
  const viewer = page.getByRole('dialog', { name: 'changes' })
  const value = viewer.getByLabel('Valeur de changes')
  await expect(value).toContainText('"display_name": {')
  await expect(value).toContainText('"before": null')
  await expect(viewer).toContainText('JSON mis en forme')
  await page.screenshot({ path: `${SCREENSHOTS}/database-audit-changes.png`, animations: 'disabled' })
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
    await grid(page, 'companies')
      .getByRole('gridcell', { name: /^Paragraphe fictif 1/ })
      .getByRole('button', { name: 'Voir la valeur complète' })
      .click()
    await expect(page.getByRole('dialog', { name: 'client_approach' })).toContainText('Paragraphe fictif 8')
    await page.screenshot({ path: `${SCREENSHOTS}/database-viewer-${theme}.png`, animations: 'disabled' })
  })
}
