import { expect, type Page, test } from '@playwright/test'

import { SCREENSHOTS, useTheme } from './helpers'
import { signIn } from './session'

// Settings (Task 06) against the real backend. The E2E database holds the seeded suggestions and the synthetic
// dataset (roles/segments in use, two referents); every value created here is invented and ends in "E2E".

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
  await page.goto('/settings')
  const roles = panel(page, 'Rôles')
  await expect(roles.getByRole('table', { name: 'Liste des rôles' })).toBeVisible()
  await expect(roles.getByRole('row', { name: /Dirigeant/ })).toContainText(/\d+ prospects?/)

  await roles.getByRole('textbox', { name: 'Nouveau rôle' }).fill('Responsable qualité E2E')
  await roles.getByRole('button', { name: 'Ajouter' }).click()
  await expect(roles.getByRole('cell', { name: 'Responsable qualité E2E', exact: true })).toBeVisible()
  await expect(roles.getByRole('status')).toHaveText('« Responsable qualité E2E » ajouté.')

  await roles.getByRole('textbox', { name: 'Nouveau rôle' }).fill('RESPONSABLE QUALITE e2e')
  await roles.getByRole('button', { name: 'Ajouter' }).click()
  await expect(roles.getByText('« Responsable qualité E2E » existe déjà.')).toBeVisible()

  await roles.getByRole('button', { name: 'Renommer « Responsable qualité E2E »' }).click()
  const rename = roles.getByRole('textbox', { name: 'Nouveau libellé pour « Responsable qualité E2E »' })
  await expect(rename).toBeFocused()
  await rename.fill('Responsable qualité et sécurité E2E')
  await rename.press('Enter')
  await expect(roles.getByRole('cell', { name: 'Responsable qualité et sécurité E2E', exact: true })).toBeVisible()

  await openPickers(page)
  const picker = page.getByRole('combobox', { name: 'Rôle', exact: true })
  await picker.fill('qualite securite')
  // The first option is active; the last one offers to create the typed text as a new role.
  const options = page.getByRole('listbox', { name: 'Rôle', exact: true }).getByRole('option')
  await expect(options).toHaveText(['Responsable qualité et sécurité E2E', 'Créer « qualite securite »'])
  await picker.press('ArrowDown')
  await picker.press('ArrowUp')
  await picker.press('Enter')
  await expect(picker).toHaveValue('Responsable qualité et sécurité E2E')

  await page.goto('/settings/roles')
  await roles.getByRole('button', { name: 'Désactiver « Responsable qualité et sécurité E2E »' }).click()
  await expect(roles.getByRole('row', { name: /Responsable qualité et sécurité E2E/ })).toContainText('Inactif')

  await openPickers(page)
  await picker.fill('qualite securite')
  await expect(options).toHaveText(['Créer « qualite securite »'])
  await picker.fill('RESPONSABLE QUALITE ET SECURITE e2e')
  await expect(page.getByText(/« Responsable qualité et sécurité E2E » existe mais est désactivé/)).toBeVisible()
  await expect(options).toHaveCount(0)
})

test('a value in use cannot be deleted; an unused one can', async ({ page }) => {
  await page.goto('/settings/commercial-segments')
  const segments = panel(page, 'Segments commerciaux')

  await segments.getByRole('button', { name: 'Supprimer « Transporteur »' }).click()
  const refusal = page.getByRole('dialog', { name: 'Suppression impossible' })
  await expect(refusal).toContainText(/« Transporteur » est utilisé par \d+ entreprises?/)
  await refusal.getByRole('button', { name: 'Annuler' }).click()

  await segments.getByRole('textbox', { name: 'Nouveau segment' }).fill('Segment éphémère E2E')
  await segments.getByRole('textbox', { name: 'Nouveau segment' }).press('Enter')
  await segments.getByRole('button', { name: 'Supprimer « Segment éphémère E2E »' }).click()
  await page.getByRole('dialog', { name: 'Supprimer « Segment éphémère E2E » ?' }).getByRole('button', { name: 'Supprimer' }).click()
  await expect(segments.getByRole('cell', { name: 'Segment éphémère E2E', exact: true })).toHaveCount(0)
})

test('a picker creates a missing value inline, through the same audited API', async ({ page }) => {
  await openPickers(page)
  const picker = page.getByRole('combobox', { name: 'Segment commercial' })
  await picker.fill('Commissionnaire E2E')
  await page.getByRole('option', { name: 'Créer « Commissionnaire E2E »' }).click()
  await expect(picker).toHaveValue('Commissionnaire E2E')

  await page.goto('/settings/commercial-segments')
  await expect(panel(page, 'Segments commerciaux').getByRole('cell', { name: 'Commissionnaire E2E', exact: true })).toBeVisible()
})

test('an internal referent is added and offered by the referent picker', async ({ page }) => {
  await page.goto('/settings/referents')
  const referents = panel(page, 'Référents internes')
  await expect(referents.getByRole('table', { name: 'Liste des référents internes' })).toBeVisible()

  await referents.getByRole('button', { name: 'Ajouter un référent' }).click()
  const dialog = page.getByRole('dialog', { name: 'Ajouter un référent' })
  await dialog.getByRole('textbox', { name: 'Prénom' }).fill('Hélène')
  await dialog.getByRole('textbox', { name: 'Nom', exact: true }).fill('Démo E2E')
  await dialog.getByRole('textbox', { name: 'Adresse e-mail' }).fill('Helene.Demo.E2E@Example.com')
  await dialog.getByRole('textbox', { name: 'Adresse e-mail' }).press('Enter')
  await expect(dialog).toHaveCount(0)
  await expect(referents.getByRole('row', { name: /Hélène Démo E2E/ })).toContainText('helene.demo.e2e@example.com')

  await openPickers(page)
  const picker = page.getByRole('combobox', { name: 'Référent' })
  await picker.fill('demo e2e')
  await expect(page.getByRole('option', { name: /Hélène Démo E2E/ })).toBeVisible()
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
    const role = page.getByRole('combobox', { name: 'Rôle', exact: true })
    await role.fill('dirigeant')
    await role.press('Enter')
    const categories = page.getByRole('combobox', { name: 'Catégories d’activité' })
    for (const category of ['entreposage', 'messagerie']) {
      await categories.fill(category)
      await categories.press('Enter')
    }
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
