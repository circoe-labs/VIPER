import { expect, type Page, test } from '@playwright/test'

import { uniqueSuffix } from './data'
import { pickFirst, SCREENSHOTS, useTheme } from './helpers'
import { signIn } from './session'

// Settings (Task 06) against the real backend. The E2E database holds the seeded suggestions and the synthetic
// dataset (roles/segments in use, two referents), read-only here; every value a test creates is its own: invented,
// "E2E" and a run-unique suffix in its label (data.ts), which is also what the pickers are searched for.

test.use({ viewport: { width: 1440, height: 900 } })

test.beforeEach(async ({ page }) => {
  await signIn(page)
})

function panel(page: Page, name: string) {
  return page.getByRole('region', { name, exact: true })
}

// The pickers are demonstrated, wired to the API, on the development showcase (the record editors come later).
async function openPickers(page: Page) {
  await page.goto('/_dev/ui')
  await expect(page.getByRole('heading', { level: 2, name: 'Sélecteurs de paramètres' })).toBeVisible()
}

test('a role is added, renamed and deactivated, and the pickers follow', async ({ page }) => {
  const suffix = uniqueSuffix()
  const role = `Responsable qualité E2E ${suffix}`
  const renamed = `Responsable qualité et sécurité E2E ${suffix}`
  const query = `qualite securite ${suffix}`

  await page.goto('/settings')
  const roles = panel(page, 'Rôles')
  await expect(roles.getByRole('table', { name: 'Liste des rôles' })).toBeVisible()
  await expect(roles.getByRole('row', { name: /Dirigeant/ })).toContainText(/\d+ prospects?/)

  await roles.getByRole('textbox', { name: 'Nouveau rôle' }).fill(role)
  await roles.getByRole('button', { name: 'Ajouter' }).click()
  await expect(roles.getByRole('cell', { name: role, exact: true })).toBeVisible()
  await expect(roles.getByRole('status')).toHaveText(`« ${role} » ajouté.`)

  await roles.getByRole('textbox', { name: 'Nouveau rôle' }).fill(`RESPONSABLE QUALITE e2e ${suffix}`)
  await roles.getByRole('button', { name: 'Ajouter' }).click()
  await expect(roles.getByText(`« ${role} » existe déjà.`)).toBeVisible()

  await roles.getByRole('button', { name: `Renommer « ${role} »` }).click()
  const rename = roles.getByRole('textbox', { name: `Nouveau libellé pour « ${role} »` })
  await expect(rename).toBeFocused()
  await rename.fill(renamed)
  await rename.press('Enter')
  await expect(roles.getByRole('cell', { name: renamed, exact: true })).toBeVisible()

  await openPickers(page)
  const picker = page.getByRole('combobox', { name: 'Rôle', exact: true })
  await picker.fill(query)
  // The first option is active; the last one offers to create the typed text as a new role.
  const options = page.getByRole('listbox', { name: 'Rôle', exact: true }).getByRole('option')
  await expect(options).toHaveText([renamed, `Créer « ${query} »`])
  await picker.press('ArrowDown')
  await picker.press('ArrowUp')
  await picker.press('Enter')
  await expect(picker).toHaveValue(renamed)

  await page.goto('/settings/roles')
  await roles.getByRole('button', { name: `Désactiver « ${renamed} »` }).click()
  await expect(roles.getByRole('row', { name: new RegExp(renamed) })).toContainText('Inactif')

  await openPickers(page)
  await picker.fill(query)
  await expect(options).toHaveText([`Créer « ${query} »`])
  await picker.fill(`RESPONSABLE QUALITE ET SECURITE e2e ${suffix}`)
  await expect(page.getByText(`« ${renamed} » existe mais est désactivé`)).toBeVisible()
  await expect(options).toHaveCount(0)
})

test('a value in use cannot be deleted; an unused one can', async ({ page }) => {
  const segment = `Segment éphémère E2E ${uniqueSuffix()}`
  await page.goto('/settings/commercial-segments')
  const segments = panel(page, 'Segments commerciaux')

  await segments.getByRole('button', { name: 'Supprimer « Transporteur »' }).click()
  const refusal = page.getByRole('dialog', { name: 'Suppression impossible' })
  await expect(refusal).toContainText(/« Transporteur » est utilisé par \d+ entreprises?/)
  await refusal.getByRole('button', { name: 'Annuler' }).click()

  await segments.getByRole('textbox', { name: 'Nouveau segment' }).fill(segment)
  await segments.getByRole('textbox', { name: 'Nouveau segment' }).press('Enter')
  await segments.getByRole('button', { name: `Supprimer « ${segment} »` }).click()
  await page.getByRole('dialog', { name: `Supprimer « ${segment} » ?` }).getByRole('button', { name: 'Supprimer' }).click()
  await expect(segments.getByRole('cell', { name: segment, exact: true })).toHaveCount(0)
})

test('a picker creates a missing value inline, through the same audited API', async ({ page }) => {
  const segment = `Commissionnaire E2E ${uniqueSuffix()}`
  await openPickers(page)
  const picker = page.getByRole('combobox', { name: 'Segment commercial' })
  await picker.fill(segment)
  await page.getByRole('option', { name: `Créer « ${segment} »` }).click()
  await expect(picker).toHaveValue(segment)

  await page.goto('/settings/commercial-segments')
  await expect(panel(page, 'Segments commerciaux').getByRole('cell', { name: segment, exact: true })).toBeVisible()
})

test('an internal referent is added and offered by the referent picker', async ({ page }) => {
  const suffix = uniqueSuffix()
  const lastName = `Démo E2E ${suffix}`
  await page.goto('/settings/referents')
  const referents = panel(page, 'Référents internes')
  await expect(referents.getByRole('table', { name: 'Liste des référents internes' })).toBeVisible()

  await referents.getByRole('button', { name: 'Ajouter un référent' }).click()
  const dialog = page.getByRole('dialog', { name: 'Ajouter un référent' })
  await dialog.getByRole('textbox', { name: 'Prénom' }).fill('Hélène')
  await dialog.getByRole('textbox', { name: 'Nom', exact: true }).fill(lastName)
  await dialog.getByRole('textbox', { name: 'Adresse e-mail' }).fill(`Helene.Demo.E2E.${suffix}@Example.com`)
  await dialog.getByRole('textbox', { name: 'Adresse e-mail' }).press('Enter')
  await expect(dialog).toHaveCount(0)
  await expect(referents.getByRole('row', { name: new RegExp(`Hélène ${lastName}`) })).toContainText(
    `helene.demo.e2e.${suffix}@example.com`,
  )

  await openPickers(page)
  const picker = page.getByRole('combobox', { name: 'Référent' })
  await picker.fill(`demo e2e ${suffix}`)
  await expect(page.getByRole('option', { name: `Hélène ${lastName}` })).toBeVisible()
})

for (const theme of ['dark', 'light'] as const) {
  test(`settings page screenshot (${theme})`, async ({ page }) => {
    await useTheme(page, theme)
    await page.goto('/settings/roles')
    await expect(panel(page, 'Rôles').getByRole('table', { name: 'Liste des rôles' })).toBeVisible()
    await page.screenshot({ path: `${SCREENSHOTS}/settings-roles-${theme}.png` })

    await page.goto('/settings/referents')
    await expect(page.getByRole('table', { name: 'Liste des référents internes' })).toBeVisible()
    await page.screenshot({ path: `${SCREENSHOTS}/settings-referents-${theme}.png` })

    await openPickers(page)
    await pickFirst(page, 'Rôle', 'dirigeant', 'Dirigeant')
    await pickFirst(page, 'Catégories d’activité', 'entreposage', 'Entreposage et stockage')
    await pickFirst(page, 'Catégories d’activité', 'messagerie', 'Messagerie et fret express')
    await expect(page.getByRole('listbox', { name: 'Catégories d’activité' }).getByRole('option', { selected: true })).toHaveCount(2)
    await page.getByRole('region', { name: 'Sélecteurs de paramètres' }).evaluate((card) => {
      window.scrollBy(0, card.getBoundingClientRect().top - 96)
    })
    await page.screenshot({ path: `${SCREENSHOTS}/settings-pickers-${theme}.png` })
  })
}

test('the settings page has no horizontal overflow at 1280 px', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto('/settings/referents')
  await expect(page.getByRole('table', { name: 'Liste des référents internes' })).toBeVisible()
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(overflow).toBe(0)
})
