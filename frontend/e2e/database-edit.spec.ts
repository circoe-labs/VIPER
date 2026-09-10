import { expect, type Page, test } from '@playwright/test'

import { createCompany, createReferent, uniqueSuffix } from './data'
import { openDatabase, SCREENSHOTS, useTheme } from './helpers'
import { signIn } from './session'

// Staged editing against the synthetic dataset, which stays read-only: edits of its rows are only staged, then
// cancelled or refused. Every saved change targets a row the test created itself (data.ts), shown through a filter.

test.use({ viewport: { width: 1440, height: 900 } })

test.beforeEach(async ({ page }) => {
  await signIn(page)
})

function grid(page: Page, table: string) {
  return page.getByRole('grid', { name: `Lignes de ${table}` })
}

// The explorer on `table`, filtered on `column` (URL view state, as a shared link would open it).
async function openFiltered(page: Page, table: string, column: string, operator: 'eq' | 'contains', value: string) {
  const filters = encodeURIComponent(JSON.stringify([{ column, operator, value }]))
  await page.goto(`/database/${table}?filters=${filters}`)
  await expect(page.getByRole('heading', { level: 1, name: 'Base de données' })).toBeVisible()
}

function pendingBar(page: Page) {
  return page.getByRole('region', { name: 'Modifications en attente' })
}

async function editCell(page: Page, table: string, current: string, column: string, value: string) {
  await grid(page, table).getByRole('gridcell', { name: current, exact: true }).dblclick()
  const input = page.getByRole('textbox', { name: `Nouvelle valeur de ${column}` })
  await input.fill(value)
  await input.press('Enter')
}

test('an edit stays pending until saved, and Cancel restores the original value', async ({ page }) => {
  await openDatabase(page, 'internal_referents')
  await editCell(page, 'internal_referents', 'Alex', 'first_name', 'Alexis')

  await expect(pendingBar(page)).toContainText('1 modification en attente')
  const edited = grid(page, 'internal_referents').locator('td[data-dirty]')
  await expect(edited).toContainText('Alexis')

  await pendingBar(page).getByRole('button', { name: 'Annuler' }).click()
  await expect(pendingBar(page)).toBeHidden()
  await expect(grid(page, 'internal_referents').getByRole('gridcell', { name: 'Alex', exact: true })).toBeVisible()
  await expect(grid(page, 'internal_referents').locator('td[data-dirty]')).toHaveCount(0)
})

test('a saved edit is persisted and recorded in the audit log', async ({ page }) => {
  const suffix = uniqueSuffix()
  const lastName = `Témoin E2E ${suffix}`
  const edited = `Témoin modifié E2E ${suffix}`
  await createReferent(page, { first_name: 'Dominique', last_name: lastName, email: null })
  // Filtered on the suffix, so the row stays in view once renamed.
  await openFiltered(page, 'internal_referents', 'last_name', 'contains', suffix)
  await editCell(page, 'internal_referents', lastName, 'last_name', edited)
  await pendingBar(page).getByRole('button', { name: 'Enregistrer' }).click()
  await expect(pendingBar(page)).toBeHidden()

  await page.reload()
  await expect(grid(page, 'internal_referents').getByRole('gridcell', { name: edited, exact: true })).toBeVisible()

  const updates = encodeURIComponent(
    JSON.stringify([
      { column: 'action', operator: 'eq', value: 'internal_referent.updated' },
      { column: 'changes', operator: 'contains', value: edited },
    ]),
  )
  await page.goto(`/database/audit_log?filters=${updates}`)
  const events = grid(page, 'audit_log')
  await expect(page.locator('.explorer-status__range')).toContainText('Lignes 1–1 sur 1')
  const event = events.locator('tbody tr').first()
  await expect(event).toContainText('Pilote E2E')
  await expect(event).toContainText('database_explorer')
  await expect(event).toContainText(edited)
})

test('leaving the table with pending changes asks first', async ({ page }) => {
  await openDatabase(page, 'internal_referents')
  await editCell(page, 'internal_referents', 'Alex', 'first_name', 'Alexandre')
  const rail = page.getByRole('navigation', { name: 'Tables' })

  await rail.getByRole('link', { name: /^roles/ }).click()
  const warning = page.getByRole('dialog', { name: 'Modifications non enregistrées' })
  await expect(warning).toContainText('1 modification en attente sur internal_referents')
  await warning.getByRole('button', { name: 'Rester sur internal_referents' }).click()
  await expect(page).toHaveURL(/\/database\/internal_referents$/)
  await expect(pendingBar(page)).toBeVisible()

  await rail.getByRole('link', { name: /^roles/ }).click()
  await page.getByRole('button', { name: 'Quitter sans enregistrer' }).click()
  await expect(grid(page, 'roles')).toBeVisible()
  await expect(pendingBar(page)).toBeHidden()
})

test('add a row, save it, then delete it after the confirmation', async ({ page }) => {
  const suffix = uniqueSuffix()
  const name = `Catégorie E2E ${suffix}`
  // Only this test's categories are in view: the new row, once saved, matches the filter.
  await openFiltered(page, 'activity_categories', 'label', 'contains', suffix)
  const categories = grid(page, 'activity_categories')

  await page.getByRole('button', { name: 'Ajouter une ligne' }).click()
  const label = page.getByRole('textbox', { name: 'Nouvelle valeur de label' })
  await label.fill(name)
  await label.press('Tab')
  await page.keyboard.press('Enter')
  const slug = page.getByRole('textbox', { name: 'Nouvelle valeur de slug' })
  await slug.fill(`categorie-e2e-${suffix}`)
  await slug.press('Enter')
  await expect(pendingBar(page)).toContainText('1 ligne ajoutée')
  await pendingBar(page).getByRole('button', { name: 'Enregistrer' }).click()
  await expect(pendingBar(page)).toBeHidden()
  const created = categories.getByRole('gridcell', { name, exact: true })
  await expect(created).toBeVisible()

  await created.click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Supprimer la ligne…' }).click()
  const dialog = page.getByRole('dialog', { name: 'Supprimer cette ligne de activity_categories ?' })
  await expect(dialog).toContainText('Aucune autre ligne n’est touchée.')
  await dialog.getByRole('button', { name: 'Marquer pour suppression' }).click()
  await expect(pendingBar(page)).toContainText('1 suppression')
  await expect(created.locator('xpath=ancestor::tr')).toHaveAttribute('data-status', 'deleted')
  await pendingBar(page).getByRole('button', { name: 'Enregistrer' }).click()
  await expect(pendingBar(page)).toBeHidden()
  await expect(categories.getByRole('gridcell', { name, exact: true })).toHaveCount(0)
})

test('a prospect deletion lists its cascades and a used company cannot be deleted', async ({ page }) => {
  await openDatabase(page, 'companies')
  await grid(page, 'companies').getByRole('gridcell', { name: 'Transports Exemple SARL' }).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Supprimer la ligne…' }).click()
  const blocked = page.getByRole('dialog', { name: 'Supprimer cette ligne de companies ?' })
  await expect(blocked.getByRole('alert')).toContainText('de prospects y font référence : suppression bloquée.')
  await expect(blocked.getByRole('button', { name: 'Supprimer avec les lignes liées' })).toBeDisabled()
  await blocked.getByRole('button', { name: 'Annuler' }).click()

  await openDatabase(page, 'prospects')
  await grid(page, 'prospects').locator('tbody tr').first().getByRole('gridcell').nth(2).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Supprimer la ligne…' }).click()
  const cascade = page.getByRole('dialog', { name: 'Supprimer cette ligne de prospects ?' })
  await expect(cascade).toContainText('Supprime aussi 1 ligne de emails (E-mails).')
  await expect(cascade.getByRole('button', { name: 'Supprimer avec les lignes liées' })).toBeEnabled()
  await cascade.getByRole('button', { name: 'Annuler' }).click()
  await expect(pendingBar(page)).toBeHidden()
})

test('a company row opens in the Company editor and the grid shows the saved value', async ({ page }) => {
  const suffix = uniqueSuffix()
  const name = `Entreprise explorateur E2E ${suffix}`
  const size = `Taille E2E ${suffix}`
  await createCompany(page, { display_name: name })
  await openFiltered(page, 'companies', 'display_name', 'eq', name)
  const companies = grid(page, 'companies')
  await companies.getByRole('gridcell', { name, exact: true }).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Ouvrir dans l’éditeur' }).click()

  const editor = page.getByRole('dialog', { name })
  await editor.getByRole('textbox', { name: 'Taille' }).fill(size)
  await editor.getByRole('button', { name: 'Enregistrer' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Entreprise enregistrée.' })).toBeVisible()
  await editor.getByRole('button', { name: 'Fermer' }).first().click()
  await expect(editor).toBeHidden()

  await expect(companies.getByRole('gridcell', { name: size, exact: true })).toBeVisible()
})

for (const theme of ['dark', 'light'] as const) {
  test(`editing screenshots (${theme})`, async ({ page }) => {
    await useTheme(page, theme)
    await openDatabase(page, 'internal_referents')
    const referents = grid(page, 'internal_referents')

    // A refused save: the invalid e-mail is flagged on its cell, nothing is saved.
    await referents.locator('tbody tr').nth(1).locator('td[data-kind="text"]').nth(2).dblclick()
    const email = page.getByRole('textbox', { name: 'Nouvelle valeur de email' })
    await email.fill('Pas-Valide')
    await email.press('Enter')
    await pendingBar(page).getByRole('button', { name: 'Enregistrer' }).click()
    await expect(pendingBar(page)).toContainText('Enregistrement refusé : 1 erreur')
    await expect(referents.locator('td[data-invalid]')).toContainText('Adresse e-mail invalide')
    await page.screenshot({ path: `${SCREENSHOTS}/database-edit-refused-${theme}.png`, animations: 'disabled' })

    // Pending edits: a modified cell, a new row, and an open editor.
    await pendingBar(page).getByRole('button', { name: 'Annuler' }).click()
    await editCell(page, 'internal_referents', 'Alex', 'first_name', 'Alexis')
    await page.getByRole('button', { name: 'Ajouter une ligne' }).click()
    await page.getByRole('textbox', { name: 'Nouvelle valeur de first_name' }).fill('Nora')
    await expect(pendingBar(page)).toContainText('2 modifications en attente')
    await page.screenshot({ path: `${SCREENSHOTS}/database-edit-pending-${theme}.png`, animations: 'disabled' })
    await page.keyboard.press('Escape')

    await page.getByRole('navigation', { name: 'Tables' }).getByRole('link', { name: /^prospects/ }).click()
    await page.getByRole('button', { name: 'Quitter sans enregistrer' }).click()
    await grid(page, 'prospects').locator('tbody tr').first().getByRole('gridcell').nth(2).click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Supprimer la ligne…' }).click()
    await expect(page.getByRole('dialog', { name: 'Supprimer cette ligne de prospects ?' })).toContainText('Supprime aussi')
    await page.screenshot({ path: `${SCREENSHOTS}/database-edit-delete-${theme}.png`, animations: 'disabled' })
  })
}
