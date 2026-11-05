import { execFileSync } from 'node:child_process'
import { expect, test } from '@playwright/test'
import { BACKEND_DIR, PYTHON } from './env'
import { uniqueSuffix } from './data'
import { useTheme } from './helpers'
import { signIn } from './session'

test('warehouse directory: create, edit, import without duplicates and responsive details', async ({ page }) => {
  test.setTimeout(120_000)
  await signIn(page)
  const tag = `Warehouse${uniqueSuffix()}`
  const name = `Entrepôt ${tag}`
  await page.goto('/warehouses')
  await expect(page.getByRole('heading', { name: 'Entrepôts', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Ajouter un entrepôt', exact: true }).click()
  const form = page.getByRole('dialog', { name: 'Ajouter un entrepôt' })
  await form.getByRole('textbox', { name: 'Nom de l’entrepôt' }).fill(name)
  await form.getByRole('textbox', { name: 'Ville', exact: true }).fill('Rouen')
  await form.getByRole('textbox', { name: 'Nom du propriétaire' }).fill('Propriétaire Exemple')
  await form.getByRole('button', { name: 'Ajouter un interlocuteur' }).click()
  await form.getByRole('textbox', { name: 'Nom et prénom' }).fill('Anne Test')
  await form.getByRole('textbox', { name: 'Fonction', exact: true }).fill('Responsable entrepôt')
  const alternatives = 'anne@exemple.test ou a.test@exemple.test'
  await form.getByRole('textbox', { name: 'E-mail(s) à confirmer' }).fill(alternatives)
  await form.getByRole('button', { name: 'Enregistrer', exact: true }).click()
  await expect(form).toBeHidden()
  const details = page.getByRole('button', { name: `Détails de ${name}` })
  await expect(details).toHaveAttribute('aria-expanded', 'false')
  await details.click()
  await expect(page.getByRole('list', { name: `Interlocuteurs de ${name}` }).getByText(alternatives, { exact: true })).toBeVisible()
  await page.getByRole('button', { name: `Modifier ${name}` }).click()
  const edit = page.getByRole('dialog', { name: 'Modifier l’entrepôt' })
  await expect(edit.getByRole('textbox', { name: 'E-mail(s) à confirmer' })).toHaveValue(alternatives)
  await edit.getByRole('textbox', { name: 'Notes' }).fill(`Note ${tag}`)
  await edit.getByRole('button', { name: 'Enregistrer', exact: true }).click()
  await expect(edit).toBeHidden()
  await page.reload()
  await expect(details).toHaveAttribute('aria-expanded', 'false')
  await details.click()
  await expect(page.getByText(`Note ${tag}`, { exact: true })).toBeVisible()

  // Synthetic source only; no real workbook or contact is used by the browser tests.
  const bytes = execFileSync(PYTHON, ['-c', 'import sys; from tests.test_warehouses import workbook; sys.stdout.buffer.write(workbook())'], { cwd: BACKEND_DIR })
  for (const repeat of [false, true]) {
    await page.getByRole('button', { name: 'Importer Excel', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Importer des entrepôts' })
    await dialog.getByLabel('Fichier Excel').setInputFiles({ name: `synthetic-${tag}.xlsx`, mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: bytes })
    await dialog.getByRole('button', { name: 'Vérifier le fichier' }).click()
    await expect(dialog.getByText('2 entrepôts', { exact: true })).toBeVisible()
    await expect(dialog.getByText('3 interlocuteurs', { exact: true })).toBeVisible()
    if (repeat) await expect(dialog.getByText('2 entrepôts déjà présents seront conservés sans modification.')).toBeVisible()
    await dialog.getByRole('button', { name: 'Importer les entrepôts' }).click()
    await expect(dialog).toBeHidden()
    await expect(page.locator('.warehouse-notice')).toContainText(repeat ? '0 entrepôt(s) ajouté(s)' : '2 entrepôt(s) ajouté(s)')
  }
  const source = await page.request.get('/api/warehouses?q=Atlas')
  const records = await source.json() as { total: number; items: { contacts: unknown[]; owner_name: string }[] }
  expect(records.total).toBe(1)
  expect(records.items[0]?.contacts).toHaveLength(2)
  expect(records.items[0]?.owner_name).toBe('Propriétaire Test')
  await page.getByRole('searchbox').fill(tag)
  await expect(page.locator('.warehouse-card')).toHaveCount(1)
  await page.getByRole('button', { name: 'Réinitialiser', exact: true }).click()
  await expect(page.locator('.warehouse-card')).toHaveCount(3)

  for (const theme of ['dark', 'light'] as const) {
    await useTheme(page, theme)
    for (const width of [1440, 1024, 390]) {
      await page.setViewportSize({ width, height: 1000 })
      await page.goto('/warehouses')
      await expect(details).toHaveAttribute('aria-expanded', 'false')
      await details.click()
      await expect(page.getByRole('list', { name: `Interlocuteurs de ${name}` }).getByText(alternatives, { exact: true })).toBeVisible()
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0)
      await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); window.scrollTo(0, 0) })
      await page.screenshot({ path: `test-results/warehouses-${theme}-${String(width)}.png`, fullPage: true })
    }
  }
})
