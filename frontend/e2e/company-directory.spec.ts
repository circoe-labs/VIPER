import { expect, test } from '@playwright/test'
import { createCompany, uniqueSuffix } from './data'
import { signIn } from './session'

test('Prospection includes companies without prospects and real category counts', async ({ page }) => {
  await signIn(page)
  const tag = `WithoutProspects${uniqueSuffix()}`
  await createCompany(page, { display_name: tag })
  const response = page.waitForResponse((answer) => new URL(answer.url()).pathname === '/api/companies/counts' && answer.ok())
  await page.goto('/prospection')
  const counts = await (await response).json() as { all: number; sme: number; large: number; institutional: number; unclassified: number }
  expect(counts.all).toBe(counts.sme + counts.large + counts.institutional + counts.unclassified)
  const directory = page.getByRole('region', { name: 'Répertoire des entreprises' })
  await expect(directory.getByRole('button', { name: 'Toutes', exact: true })).toContainText(new Intl.NumberFormat('fr-FR').format(counts.all))
  await expect(directory.getByRole('button', { name: 'À classer', exact: true })).toContainText(new Intl.NumberFormat('fr-FR').format(counts.unclassified))
  await directory.getByRole('button', { name: 'Toutes', exact: true }).click()
  await directory.getByRole('searchbox').fill(tag)
  const table = directory.getByRole('table', { name: 'Liste des entreprises' })
  await expect(table.getByRole('row')).toHaveCount(2)
  const row = table.getByRole('row', { name: new RegExp(tag) })
  await expect(row.getByRole('cell').last()).toHaveText('0')
  await table.getByRole('button', { name: tag, exact: true }).click()
  await expect(page.getByRole('dialog', { name: tag, exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await page.setViewportSize({ width: 1440, height: 1000 })
  await directory.getByRole('searchbox').fill('')
  await expect(directory.getByRole('table').getByRole('row')).toHaveCount(Math.min(counts.all, 50) + 1)
  await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); window.scrollTo(0, 0) })
  await page.screenshot({ path: 'test-results/company-directory-desktop.png', fullPage: true })
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0)
})
