import { randomBytes } from 'node:crypto'

import { expect, type Page, test } from '@playwright/test'

import { syntheticWorkbook } from './data'
import { SCREENSHOTS, useTheme } from './helpers'
import { signIn } from './session'

// Excel import review and commit (Task 09) against the real backend. The workbook is synthetic, generated in memory
// by the backend fixture (tests/fixtures/synthetic/legacy_workbook.py: the legacy layout with an `actualité` sheet);
// every name carries a random suffix drawn by the test, so each test owns its rows in the shared E2E database
// (I-81). A random hex suffix rather than `uniqueSuffix()`: the import compares company names by similarity, and
// suffixes from one worker differ only in their last digits.

test.use({ viewport: { width: 1440, height: 900 } })

test.beforeEach(async ({ page }) => {
  await signIn(page)
})

function syntheticRows(suffix: string) {
  const company = `Transports Import ${suffix}`
  const title = `Directeur fictif ${suffix}`
  return [
    { company, civility: 'M.', last_name: `Essai${suffix}`, first_name: 'Jean', job: title, email: `jean.${suffix}@import-${suffix}.example`, week: 'S37', referent: 'xxx', mode: 'Auto' },
    { company: company.toUpperCase(), civility: 'Mme', last_name: `Essai${suffix}`, first_name: 'Claire', job: title, email: `claire.${suffix}@import-${suffix}.example`, week: 'S39' },
    { company: `Messagerie Import ${suffix}`, category: 'Transport routier de marchandises', phone: '01 00 00 00 03' },
    { company: `Messagerie Import ${suffix}`, civility: 0, last_name: `Modèle${suffix}`, first_name: 'Léa', mobile: 600000004, week: 'retraité' },
    { company: `Fret Import ${suffix}`, civility: 'M', last_name: `Fictif${suffix}`, first_name: 'Hugo', rdv: 'oui', relance1: 'x', address: "12 rue de l'Exemple, 69000 Lyon", category: '2. Logistique & Stockage / Transporteur' },
    { company: `Fret Import ${suffix}`, civility: 'Mme', last_name: `Test${suffix}`, first_name: 'Emma', email: 'emma.invalide@', job: 'Responsable transport', referent: 'parti à la retraite' },
  ]
}

async function uploadWorkbook(page: Page, suffix: string) {
  await page.goto('/prospection')
  await page.getByRole('link', { name: 'Importer Excel' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Importer un fichier Excel' })).toBeVisible()
  await page.getByLabel('Fichier à importer').setInputFiles({
    name: `base-e2e-${suffix}.xlsx`,
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer: syntheticWorkbook(syntheticRows(suffix)),
  })
  await expect(page.getByText(/Feuille des prospects détectée/)).toContainText('« Base client')
  await expect(page.getByRole('list', { name: 'Feuilles ignorées' })).toContainText('Feuille « actualité » ignorée')
  await page.getByRole('button', { name: 'Confirmer la feuille' }).click()
  await expect(page.getByRole('heading', { name: 'Résumé de l’analyse' })).toBeVisible()
}

test('a synthetic workbook is reviewed, resolved and committed, then found in the history and the explorer', async ({
  page,
}) => {
  const suffix = randomBytes(3).toString('hex')
  await uploadWorkbook(page, suffix)
  const summary = page.getByRole('region', { name: 'Résumé de l’analyse' })
  await expect(summary.getByRole('button', { name: /^6\s*Lignes/ })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Importer…' })).toBeDisabled()

  // Grouped mapping: one decision for the two rows sharing the unknown job title — an explicitly created role.
  const roles = page.getByRole('region', { name: /Rôles non reconnus/ })
  await expect(roles.getByText(`« Directeur fictif ${suffix} »`)).toBeVisible()
  await roles.getByRole('combobox', { name: `Rôle pour « Directeur fictif ${suffix} »` }).selectOption('create')
  const label = roles.getByRole('textbox', { name: 'Libellé du rôle à créer' })
  await label.fill(`Directeur import ${suffix}`)
  await label.blur()
  // Weeks without year get a date only from an explicit year.
  await page.getByRole('combobox', { name: 'Année pour toutes les semaines' }).selectOption({ index: 2 })
  // The row without any name is excluded (errors block the import, warnings do not).
  await page.getByRole('button', { name: 'Exclure la ligne 4' }).click()
  await expect(page.getByRole('button', { name: 'Importer…' })).toBeEnabled()

  await page.getByRole('tab', { name: /Lignes/ }).click()
  await page.getByRole('searchbox', { name: /Rechercher : ligne/ }).fill('Emma')
  await page.getByRole('button', { name: 'Détails de la ligne 7' }).click()
  await expect(page.getByText(/Adresse e-mail invalide : ignorée/)).toBeVisible()

  await page.getByRole('button', { name: 'Importer…' }).click()
  const dialog = page.getByRole('dialog', { name: 'Confirmer l’import' })
  const plan = dialog.getByRole('list', { name: 'Ce qui sera enregistré' })
  await expect(plan).toContainText('5 nouveaux prospects')
  await expect(plan).toContainText(`Rôles créés : « Directeur import ${suffix} »`)
  await expect(plan).toContainText('1 ligne exclue (non importée)')
  await dialog.getByRole('textbox', { name: /Référence de la source/ }).fill(`Liste E2E ${suffix}`)
  await dialog.getByRole('button', { name: 'Importer 5 lignes' }).click()

  await expect(page.getByRole('heading', { name: 'Import terminé' })).toBeVisible()
  await expect(page.getByRole('list', { name: 'Résultat de l’import' })).toContainText('5 prospects créés')
  const history = page.getByRole('table', { name: 'Historique des imports' })
  const batchRow = history.getByRole('row', { name: new RegExp(`base-e2e-${suffix}\\.xlsx`) })
  await expect(batchRow).toContainText('5 / 6')
  await expect(batchRow).toContainText('Importé')

  await page.goto('/database/prospects')
  await page.getByRole('searchbox', { name: 'Rechercher dans prospects' }).fill(`Essai${suffix}`)
  await expect(page.getByRole('row', { name: /Jean/ }).first()).toBeVisible()
  await expect(page.getByRole('row', { name: /Claire/ }).first()).toBeVisible()
})

for (const theme of ['dark', 'light'] as const) {
  test(`import review screenshots (${theme})`, async ({ page }) => {
    await useTheme(page, theme)
    await uploadWorkbook(page, randomBytes(3).toString('hex'))
    await page.mouse.move(0, 0)
    await page.screenshot({ path: `${SCREENSHOTS}/import-summary-${theme}.png`, animations: 'disabled' })
    await page.getByRole('heading', { name: /Rôles non reconnus/ }).scrollIntoViewIfNeeded()
    await page.screenshot({ path: `${SCREENSHOTS}/import-resolve-${theme}.png`, animations: 'disabled' })
    await page.getByRole('tab', { name: /Lignes/ }).click()
    await page.getByRole('button', { name: 'Détails de la ligne 5' }).click()
    await page.getByRole('table', { name: 'Lignes analysées' }).scrollIntoViewIfNeeded()
    await page.screenshot({ path: `${SCREENSHOTS}/import-rows-${theme}.png`, animations: 'disabled' })
    const width = await page.evaluate(() => document.documentElement.scrollWidth)
    expect(width).toBeLessThanOrEqual(1440)
  })
}
