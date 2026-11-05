import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'

import { createCompany, post, uniqueSuffix } from './data'
import { SCREENSHOTS, useTheme } from './helpers'
import { signIn } from './session'

test('company classification persists and separates all its contacts in Prospection', async ({ page }) => {
  await signIn(page)
  await useTheme(page, 'dark')
  const tag = `Classement${uniqueSuffix()}`
  const company = await createCompany(page, { display_name: tag })
  for (const first_name of ['Alice', 'Bruno']) {
    await post(page, '/api/prospects', {
      first_name, last_name: tag, company_id: company.id,
      employment_verification: { action: 'verified_now' },
      emails: [], phones: [], provenance: { legal_basis_or_collection_context: 'Test synthétique' },
    })
  }
  await page.goto('/prospection/companies')
  await page.getByRole('searchbox').fill(tag)
  const categories = page.getByRole('group', { name: 'Type d’entreprise' })
  await categories.getByRole('button', { name: 'À classer', exact: true }).click()
  await page.getByRole('button', { name: tag, exact: true }).click()
  const editor = page.getByRole('dialog', { name: tag, exact: true })
  await editor.getByRole('combobox', { name: 'Type d’entreprise' }).selectOption('sme')
  await editor.getByRole('button', { name: 'Enregistrer', exact: true }).click()
  await expect(editor.getByText('Entreprise enregistrée.')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByText('Aucune entreprise dans cette catégorie', { exact: false })).toBeVisible()
  await categories.getByRole('button', { name: 'PME', exact: true }).click()
  await expect(page.getByRole('button', { name: tag, exact: true })).toBeVisible()

  await page.goto(`/prospection?q=${tag}&company_kind=sme`)
  const directory = page.getByRole('region', { name: 'Répertoire des entreprises' })
  await expect(directory.getByRole('button', { name: 'Afficher les entreprises', exact: true })).toHaveAttribute('aria-expanded', 'false')
  await directory.getByRole('button', { name: 'Afficher les entreprises', exact: true }).click()
  await expect(directory.getByRole('table', { name: 'Liste des entreprises' }).getByRole('button', { name: tag, exact: true })).toBeVisible()
  await directory.getByRole('button', { name: 'Masquer les entreprises', exact: true }).click()
  const list = page.getByRole('list', { name: 'Prospects', exact: true })
  await expect(list.getByRole('listitem')).toHaveCount(2)
  await page.reload()
  await expect(list.getByRole('listitem')).toHaveCount(2)
  for (const label of ['Institutionnelles', 'Grosses entreprises', 'À classer']) {
    await categories.getByRole('button', { name: label, exact: true }).click()
    await expect(page.getByText('Aucun prospect ne correspond à ces critères.')).toBeVisible()
  }
  await categories.getByRole('button', { name: 'PME', exact: true }).focus()
  await page.keyboard.press('Enter')
  await expect(list.getByRole('listitem')).toHaveCount(2)
  await page.setViewportSize({ width: 1280, height: 800 })
  await categories.getByRole('button', { name: 'Toutes', exact: true }).click()
  await directory.getByRole('searchbox').fill(tag)
  await expect(directory.getByRole('table', { name: 'Liste des entreprises' }).getByRole('row')).toHaveCount(2)
  await expect(directory.getByRole('table', { name: 'Liste des entreprises' }).getByRole('button', { name: tag, exact: true })).toBeVisible()
  await page.screenshot({ path: `${SCREENSHOTS}/prospection-company-types.png`, fullPage: true })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  const accessibility = await new AxeBuilder({ page }).include('.company-kind-filter').analyze()
  expect(accessibility.violations).toEqual([])
})
