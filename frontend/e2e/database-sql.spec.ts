import { expect, type Page, test } from '@playwright/test'

import { openDatabase, SCREENSHOTS, useTheme } from './helpers'
import { signIn } from './session'

// Read-only SQL console against the synthetic dataset, as the provisioned reader role (global setup).

test.use({ viewport: { width: 1440, height: 900 } })

test.beforeEach(async ({ page }) => {
  await signIn(page)
})

async function openConsole(page: Page) {
  await openDatabase(page)
  await page.getByRole('button', { name: 'Console SQL' }).click()
  return page.getByRole('dialog', { name: 'Console SQL' })
}

async function runQuery(page: Page, sql: string) {
  const editor = page.getByRole('textbox', { name: 'Requête' })
  await editor.fill(sql)
  await editor.press('Control+Enter')
}

test('a read shows its rows, row count and duration', async ({ page }) => {
  const panel = await openConsole(page)
  await runQuery(page, 'SELECT display_name, siren FROM companies ORDER BY display_name LIMIT 5')

  const result = panel.getByRole('region', { name: 'Résultat de la requête' })
  await expect(result.getByRole('status')).toContainText('5 lignes')
  await expect(result.getByRole('cell', { name: 'Affrètement Démo SA' })).toBeVisible()
  await expect(result.getByRole('columnheader', { name: /siren/ })).toBeVisible()
})

test('hidden tables and writes are refused by the database, nothing changes', async ({ page }) => {
  const panel = await openConsole(page)
  const result = panel.getByRole('region', { name: 'Résultat de la requête' })
  // Other specs may add companies: compare with the count read first.
  await runQuery(page, 'SELECT count(*) AS companies FROM companies')
  await expect(result.getByRole('status')).toContainText('1 ligne')
  const before = await result.getByRole('cell').first().innerText()

  await runQuery(page, 'SELECT email, password_hash FROM users')
  await expect(panel.getByRole('alert')).toContainText('Table non accessible')

  await runQuery(page, 'DELETE FROM companies')
  await expect(panel.getByRole('alert')).toContainText('lecture seule')

  // Passes the early check (it starts with WITH): refused by the database.
  await runQuery(page, 'WITH gone AS (DELETE FROM companies RETURNING id) SELECT count(*) FROM gone')
  await expect(panel.getByRole('alert')).toContainText('non prise en charge')

  await runQuery(page, 'SELECT count(*) AS companies FROM companies')
  await expect(result.getByRole('cell').first()).toHaveText(before)
})

test('a large result is cut at the row limit', async ({ page }) => {
  const panel = await openConsole(page)
  await runQuery(page, 'SELECT n FROM generate_series(1, 5000) AS n')

  await expect(panel.getByText(/Résultat tronqué : seules les 1\s000 premières lignes/)).toBeVisible()
})

for (const theme of ['dark', 'light'] as const) {
  test(`SQL console screenshots (${theme})`, async ({ page }) => {
    await useTheme(page, theme)
    const panel = await openConsole(page)
    await runQuery(
      page,
      [
        'SELECT c.display_name, c.siren, count(p.id) AS prospects, max(p.updated_at) AS last_update',
        'FROM companies c JOIN prospects p ON p.company_id = c.id',
        'GROUP BY c.id ORDER BY prospects DESC, c.display_name',
        'LIMIT 20',
      ].join('\n'),
    )
    await expect(panel.getByRole('region', { name: 'Résultat de la requête' }).getByRole('status')).toContainText('20 lignes')
    await page.screenshot({ path: `${SCREENSHOTS}/database-sql-${theme}.png`, animations: 'disabled' })

    await runQuery(page, 'SELECT display_name FORM companies')
    await expect(panel.getByRole('alert')).toContainText('Erreur de syntaxe à la position 26.')
    await page.screenshot({ path: `${SCREENSHOTS}/database-sql-error-${theme}.png`, animations: 'disabled' })
  })
}
