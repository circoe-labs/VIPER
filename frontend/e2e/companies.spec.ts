import { expect, type Page, test } from '@playwright/test'

import { SCREENSHOTS, useTheme } from './helpers'
import { signIn } from './session'

// Company editor (Task 07) against the real backend. The E2E database holds the synthetic explorer dataset (36
// companies with prospects); every company created here is invented and ends in "E2E". Identifiers pass their check
// digit: SIREN 999 000 011, SIRETs 999 000 011 00018 / 00026; 999 000 020 00001 belongs to another SIREN.
const SIREN = '999 000 011'
const SIRET_HEAD = '99900001100018'
const SIRET_DEPOT = '99900001100026'
const SIRET_OTHER_SIREN = '99900002000001'
const NAME = 'Transports Démo E2E'

test.use({ viewport: { width: 1440, height: 900 } })

test.beforeEach(async ({ page }) => {
  await signIn(page)
})

function editor(page: Page) {
  return page.getByRole('dialog').first()
}

function establishment(page: Page, index: number) {
  return editor(page).getByRole('group').nth(index)
}

async function pick(page: Page, label: string, text: string) {
  const picker = editor(page).getByRole('combobox', { name: label, exact: true })
  await picker.fill(text)
  await picker.press('Enter')
}

async function openCompanies(page: Page) {
  await page.goto('/prospection')
  await page.getByRole('link', { name: 'Gérer les entreprises' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Entreprises' })).toBeVisible()
  const navigation = page.getByRole('navigation', { name: 'Navigation principale' })
  await expect(navigation.getByRole('link', { name: 'Prospection' })).toHaveAttribute('aria-current', 'page')
}

test('a company is created with two establishments and categories, then edited', async ({ page }) => {
  await openCompanies(page)
  await page.getByRole('button', { name: 'Nouvelle entreprise' }).first().click()
  const drawer = editor(page)
  await expect(drawer.getByRole('heading', { name: 'Nouvelle entreprise' })).toBeVisible()
  await expect(drawer.getByRole('textbox', { name: /Nom de l’entreprise/ })).toBeFocused()

  await drawer.getByRole('textbox', { name: /Nom de l’entreprise/ }).fill(NAME)
  await drawer.getByRole('textbox', { name: 'Raison sociale' }).fill('Transports Démonstration E2E SAS')
  await drawer.getByRole('textbox', { name: 'SIREN' }).fill(SIREN)
  await drawer.getByRole('textbox', { name: 'Site web' }).fill('www.demo-e2e.example.com')
  await drawer.getByRole('button', { name: /Utiliser « demo-e2e.example.com »/ }).click()
  await expect(drawer.getByRole('textbox', { name: 'Domaine e-mail' })).toHaveValue('demo-e2e.example.com')
  await drawer.getByRole('textbox', { name: 'Taille' }).fill('50-249 salariés')

  await pick(page, 'Segment commercial', 'transporteur')
  await pick(page, 'Catégories d’activité', 'entreposage')
  const categories = drawer.getByRole('combobox', { name: 'Catégories d’activité' })
  await categories.fill('Transport frigorifique E2E')
  await drawer.getByRole('option', { name: 'Créer « Transport frigorifique E2E »' }).click()
  await expect(drawer.getByRole('button', { name: 'Retirer « Transport frigorifique E2E »' })).toBeVisible()

  await drawer.getByRole('button', { name: 'Ajouter un établissement' }).click()
  const head = establishment(page, 0)
  await expect(head.getByRole('textbox', { name: 'Nom de l’établissement' })).toBeFocused()
  await head.getByRole('textbox', { name: 'Nom de l’établissement' }).fill('Siège')
  // `Type` suggests values through a datalist, hence a combobox.
  await head.getByRole('combobox', { name: 'Type' }).fill('siège')
  await head.getByRole('textbox', { name: 'SIRET' }).fill(SIRET_HEAD)
  await head.getByRole('textbox', { name: 'Ville' }).fill('Lyon')

  await drawer.getByRole('button', { name: 'Ajouter un établissement' }).click()
  const depot = establishment(page, 1)
  await depot.getByRole('textbox', { name: 'Nom de l’établissement' }).fill('Entrepôt Nord')
  await depot.getByRole('textbox', { name: 'SIRET' }).fill(SIRET_OTHER_SIREN)
  await expect(depot.getByText(/ne commence pas par le SIREN de l’entreprise \(999 000 011\)/)).toBeVisible()
  await depot.getByRole('textbox', { name: 'SIRET' }).fill(SIRET_DEPOT)
  await expect(depot.getByText(/ne commence pas par le SIREN/)).toHaveCount(0)
  await depot.getByRole('textbox', { name: 'Ville' }).fill('Lille')
  await expect(head.getByRole('radio', { name: 'Établissement principal' })).toBeChecked()

  await expect(drawer.getByRole('status')).toHaveText('Modifications non enregistrées')
  await page.getByRole('button', { name: 'Enregistrer' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Entreprise enregistrée.' })).toBeVisible()
  await expect(drawer.getByRole('heading', { name: NAME })).toBeVisible()
  await expect(drawer.getByRole('region', { name: 'Prospects associés' })).toContainText('Aucun prospect')

  await page.getByRole('button', { name: 'Fermer' }).last().click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await page.getByRole('searchbox').fill('999000011')
  const row = page.getByRole('row', { name: new RegExp(NAME) })
  await expect(row).toContainText('999 000 011')
  await expect(row).toContainText('Lyon')

  // Edit: the depot becomes the primary establishment; Ctrl+S saves.
  await row.getByRole('button', { name: NAME }).click()
  await expect(establishment(page, 1).getByRole('textbox', { name: 'Ville' })).toHaveValue('Lille')
  await establishment(page, 1).getByRole('radio', { name: 'Établissement principal' }).check()
  await editor(page).getByRole('textbox', { name: 'Taille' }).fill('250-999 salariés')
  await page.keyboard.press('Control+s')
  await expect(page.getByRole('status').filter({ hasText: 'Entreprise enregistrée.' })).toBeVisible()
  // Primary first after saving.
  await expect(establishment(page, 0).getByRole('textbox', { name: 'Nom de l’établissement' })).toHaveValue('Entrepôt Nord')
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(row).toContainText('Lille')
})

test('a SIREN already held by another company is refused with its name', async ({ page }) => {
  await openCompanies(page)
  await page.getByRole('button', { name: 'Nouvelle entreprise' }).first().click()
  const drawer = editor(page)
  await drawer.getByRole('textbox', { name: /Nom de l’entreprise/ }).fill('Doublon E2E')
  await drawer.getByRole('textbox', { name: 'SIREN' }).fill('999000012')
  await drawer.getByRole('textbox', { name: 'Raison sociale' }).focus()
  await expect(drawer.getByText('Ce SIREN n’est pas valide : un chiffre est sans doute erroné (clé de contrôle).')).toBeVisible()

  await drawer.getByRole('textbox', { name: 'SIREN' }).fill(SIREN)
  await page.getByRole('button', { name: 'Enregistrer' }).click()
  await expect(drawer.getByText(`Ce SIREN est déjà celui de « ${NAME} ».`).first()).toBeVisible()
  await expect(drawer.getByRole('textbox', { name: 'SIREN' })).toBeFocused()

  // Closing with unsaved changes asks first.
  await page.keyboard.press('Escape')
  const confirm = page.getByRole('dialog', { name: 'Abandonner les modifications ?' })
  await confirm.getByRole('button', { name: 'Fermer sans enregistrer' }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
})

test('a company with prospects cannot be deleted', async ({ page }) => {
  await openCompanies(page)
  const first = page.getByRole('table', { name: 'Liste des entreprises' }).getByRole('row').nth(1)
  await first.getByRole('button').click()
  const drawer = editor(page)
  await expect(drawer.getByRole('region', { name: 'Prospects associés' }).getByRole('listitem').first()).toBeVisible()
  await drawer.getByRole('button', { name: 'Supprimer' }).click()
  const refusal = page.getByRole('dialog', { name: 'Suppression impossible' })
  await expect(refusal).toContainText(/est rattachée à \d+ prospects?/)
  await refusal.getByRole('button', { name: 'Fermer' }).last().click()
  await expect(drawer).toBeVisible()
})

for (const theme of ['dark', 'light'] as const) {
  test(`company editor screenshots (${theme})`, async ({ page }) => {
    await useTheme(page, theme)
    await openCompanies(page)
    await expect(page.getByRole('table', { name: 'Liste des entreprises' })).toBeVisible()
    await page.screenshot({ path: `${SCREENSHOTS}/companies-list-${theme}.png`, animations: 'disabled' })

    await page.getByRole('searchbox').fill(NAME)
    await page.getByRole('button', { name: NAME }).click()
    await expect(establishment(page, 1)).toBeVisible()
    await editor(page).getByRole('textbox', { name: 'Taille' }).fill('Plus de 1000 salariés')
    await page.screenshot({ path: `${SCREENSHOTS}/company-editor-${theme}.png`, animations: 'disabled' })
    await establishment(page, 0).scrollIntoViewIfNeeded()
    await page.screenshot({ path: `${SCREENSHOTS}/company-editor-establishments-${theme}.png`, animations: 'disabled' })
  })
}

test('the companies page has no horizontal overflow at 1280 px', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await openCompanies(page)
  await expect(page.getByRole('table', { name: 'Liste des entreprises' })).toBeVisible()
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(overflow).toBe(0)
})
