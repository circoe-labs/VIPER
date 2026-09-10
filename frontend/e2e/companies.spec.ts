import { expect, type Page, test } from '@playwright/test'

import { createCompany, syntheticSiren, syntheticSiret, uniqueSuffix } from './data'
import { pickFirst, SCREENSHOTS, useTheme } from './helpers'
import { signIn } from './session'

// Company editor (Task 07) against the real backend. The E2E database holds the synthetic explorer dataset (36
// companies with prospects), read-only here; every company a test needs is its own, invented, with an "E2E" name and
// identifiers that pass their check digit (data.ts), so tests run in parallel and repeat freely.
const INVALID_SIREN = '999000012'

test.use({ viewport: { width: 1440, height: 900 } })

// "999 030 125": how the editor and the list print a SIREN.
function spaced(siren: string): string {
  return siren.replace(/(\d{3})(?=\d)/g, '$1 ')
}

test.beforeEach(async ({ page }) => {
  await signIn(page)
})

function editor(page: Page) {
  return page.getByRole('dialog').first()
}

function establishment(page: Page, index: number) {
  return editor(page).getByRole('group').nth(index)
}

async function openCompanies(page: Page) {
  await page.goto('/prospection')
  await page.getByRole('link', { name: 'Gérer les entreprises' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Entreprises' })).toBeVisible()
  const navigation = page.getByRole('navigation', { name: 'Navigation principale' })
  await expect(navigation.getByRole('link', { name: 'Prospection' })).toHaveAttribute('aria-current', 'page')
}

test('a company is created with two establishments and categories, then edited', async ({ page }) => {
  const suffix = uniqueSuffix()
  const name = `Transports Démo E2E ${suffix}`
  const siren = syntheticSiren(suffix)
  const otherSiren = syntheticSiren(uniqueSuffix())
  const domain = `demo-e2e-${suffix}.example.com`
  const category = `Transport frigorifique E2E ${suffix}`

  await openCompanies(page)
  await page.getByRole('button', { name: 'Nouvelle entreprise' }).first().click()
  const drawer = editor(page)
  await expect(drawer.getByRole('heading', { name: 'Nouvelle entreprise' })).toBeVisible()
  await expect(drawer.getByRole('textbox', { name: /Nom de l’entreprise/ })).toBeFocused()

  await drawer.getByRole('textbox', { name: /Nom de l’entreprise/ }).fill(name)
  await drawer.getByRole('textbox', { name: 'Raison sociale' }).fill(`Transports Démonstration E2E ${suffix} SAS`)
  await drawer.getByRole('textbox', { name: 'SIREN' }).fill(spaced(siren))
  await drawer.getByRole('textbox', { name: 'Site web' }).fill(`www.${domain}`)
  await drawer.getByRole('button', { name: `Utiliser « ${domain} », le domaine du site` }).click()
  await expect(drawer.getByRole('textbox', { name: 'Domaine e-mail' })).toHaveValue(domain)
  await drawer.getByRole('textbox', { name: 'Taille' }).fill('50-249 salariés')

  await pickFirst(drawer, 'Segment commercial', 'transporteur', 'Transporteur')
  await pickFirst(drawer, 'Catégories d’activité', 'entreposage', 'Entreposage et stockage')
  const categories = drawer.getByRole('combobox', { name: 'Catégories d’activité' })
  await categories.fill(category)
  await drawer.getByRole('option', { name: `Créer « ${category} »` }).click()
  await expect(drawer.getByRole('button', { name: `Retirer « ${category} »` })).toBeVisible()

  await drawer.getByRole('button', { name: 'Ajouter un établissement' }).click()
  const head = establishment(page, 0)
  await expect(head.getByRole('textbox', { name: 'Nom de l’établissement' })).toBeFocused()
  await head.getByRole('textbox', { name: 'Nom de l’établissement' }).fill('Siège')
  // `Type` suggests values through a datalist, hence a combobox.
  await head.getByRole('combobox', { name: 'Type' }).fill('siège')
  await head.getByRole('textbox', { name: 'SIRET' }).fill(syntheticSiret(siren, 1))
  await head.getByRole('textbox', { name: 'Ville' }).fill('Lyon')

  await drawer.getByRole('button', { name: 'Ajouter un établissement' }).click()
  const depot = establishment(page, 1)
  await depot.getByRole('textbox', { name: 'Nom de l’établissement' }).fill('Entrepôt Nord')
  await depot.getByRole('textbox', { name: 'SIRET' }).fill(syntheticSiret(otherSiren, 1))
  await expect(depot.getByText(`ne commence pas par le SIREN de l’entreprise (${spaced(siren)})`)).toBeVisible()
  await depot.getByRole('textbox', { name: 'SIRET' }).fill(syntheticSiret(siren, 2))
  await expect(depot.getByText(/ne commence pas par le SIREN/)).toHaveCount(0)
  await depot.getByRole('textbox', { name: 'Ville' }).fill('Lille')
  await expect(head.getByRole('radio', { name: 'Établissement principal' })).toBeChecked()

  await expect(drawer.getByRole('status')).toHaveText('Modifications non enregistrées')
  // Saved with the mouse: the focused button is disabled while saving and stays so (nothing left to save); focus stays
  // in the drawer and Esc closes it, with no confirmation since nothing is unsaved.
  await page.getByRole('button', { name: 'Enregistrer' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Entreprise enregistrée.' })).toBeVisible()
  await expect(drawer.getByRole('heading', { name })).toBeVisible()
  await expect(drawer.getByRole('region', { name: 'Prospects associés' })).toContainText('Aucun prospect')
  await expect(drawer).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)

  // The search by SIREN finds this company alone (waiting for it also keeps its request from racing the next save).
  await page.getByRole('searchbox').fill(siren)
  const companies = page.getByRole('table', { name: 'Liste des entreprises' })
  await expect(companies.getByRole('row')).toHaveCount(2)
  const row = companies.getByRole('row', { name: new RegExp(name) })
  await expect(row).toContainText(spaced(siren))
  await expect(row).toContainText('Lyon')

  // Edit: the depot becomes the primary establishment; Ctrl+S saves.
  await row.getByRole('button', { name }).click()
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
  const suffix = uniqueSuffix()
  const holder = `Logistique Témoin E2E ${suffix}`
  const siren = syntheticSiren(suffix)
  await createCompany(page, { display_name: holder, siren })

  await openCompanies(page)
  await page.getByRole('button', { name: 'Nouvelle entreprise' }).first().click()
  const drawer = editor(page)
  await drawer.getByRole('textbox', { name: /Nom de l’entreprise/ }).fill(`Doublon E2E ${uniqueSuffix()}`)
  await drawer.getByRole('textbox', { name: 'SIREN' }).fill(INVALID_SIREN)
  await drawer.getByRole('textbox', { name: 'Raison sociale' }).focus()
  await expect(drawer.getByText('Ce SIREN n’est pas valide : un chiffre est sans doute erroné (clé de contrôle).')).toBeVisible()

  await drawer.getByRole('textbox', { name: 'SIREN' }).fill(siren)
  await page.getByRole('button', { name: 'Enregistrer' }).click()
  await expect(drawer.getByText(`Ce SIREN est déjà celui de « ${holder} ».`).first()).toBeVisible()
  await expect(drawer.getByRole('textbox', { name: 'SIREN' })).toBeFocused()

  // Closing with unsaved changes asks first.
  await page.keyboard.press('Escape')
  const confirm = page.getByRole('dialog', { name: 'Abandonner les modifications ?' })
  await confirm.getByRole('button', { name: 'Fermer sans enregistrer' }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
})

test('a company with prospects cannot be deleted', async ({ page }) => {
  await openCompanies(page)
  // A synthetic company of the read-only dataset: it has prospects.
  await page.getByRole('searchbox').fill('Transports Exemple SARL')
  await page.getByRole('button', { name: 'Transports Exemple SARL' }).click()
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
    const suffix = uniqueSuffix()
    const name = `Transports Démo E2E ${suffix}`
    const siren = syntheticSiren(suffix)
    await createCompany(page, {
      display_name: name,
      legal_name: `Transports Démonstration E2E ${suffix} SAS`,
      siren,
      website_url: `https://www.demo-e2e-${suffix}.example.com`,
      email_domain: `demo-e2e-${suffix}.example.com`,
      size_label: '250-999 salariés',
      establishments: [
        { name: 'Entrepôt Nord', siret: syntheticSiret(siren, 2), city: 'Lille', is_primary: true },
        { name: 'Siège', siret: syntheticSiret(siren, 1), city: 'Lyon', kind: 'siège', is_primary: false },
      ],
    })

    await useTheme(page, theme)
    await openCompanies(page)
    await expect(page.getByRole('table', { name: 'Liste des entreprises' })).toBeVisible()
    await page.screenshot({ path: `${SCREENSHOTS}/companies-list-${theme}.png`, animations: 'disabled' })

    await page.getByRole('searchbox').fill(name)
    await page.getByRole('button', { name }).click()
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
