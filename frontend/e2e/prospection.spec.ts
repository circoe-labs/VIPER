import { expect, type Page, test } from '@playwright/test'

import { createReferent, importProspects, uniqueSuffix } from './data'
import { SCREENSHOTS, useTheme } from './helpers'
import { signIn } from './session'

// Prospection workspace (Task 14) against the real backend. The test imports its own synthetic people through the
// import API (every name carries its `uniqueSuffix()`) and narrows the page to them with a search term only they
// match, so counts are its own whatever other tests write meanwhile (I-81). Screenshots use the read-only dataset.

test.beforeEach(async ({ page }) => {
  await signIn(page)
})

const DAY = 24 * 60 * 60 * 1000

// ISO 8601 week (and its year) of a date, as the import reads `S37` + a year.
function isoWeek(day: Date): { year: number; week: number } {
  const date = new Date(Date.UTC(day.getFullYear(), day.getMonth(), day.getDate()))
  date.setUTCDate(date.getUTCDate() + 4 - (date.getUTCDay() || 7))
  const yearStart = Date.UTC(date.getUTCFullYear(), 0, 1)
  return { year: date.getUTCFullYear(), week: Math.ceil(((date.getTime() - yearStart) / DAY + 1) / 7) }
}

function card(page: Page, label: string) {
  return page.getByRole('region', { name: 'Compteurs' }).getByRole('button', { name: new RegExp(`^${label}`) })
}

async function expectCount(page: Page, label: string, count: number) {
  await expect(card(page, label).locator('.counter-card__count')).toHaveText(String(count))
}

function people(page: Page) {
  return page.getByRole('list', { name: 'Prospects' })
}

test.use({ viewport: { width: 1440, height: 900 } })

test('counters narrow the list to the right people, kept in the URL; a person opens in the editor', async ({
  page,
}) => {
  const suffix = uniqueSuffix()
  const tag = `PE2E${suffix}`
  const referentName = { first_name: 'Référente', last_name: `Suivi${suffix}` }
  await createReferent(page, { ...referentName, email: null })
  const past = isoWeek(new Date(Date.now() - 14 * DAY))
  const future = isoWeek(new Date(Date.now() + 21 * DAY))
  const company = `Transports ${tag}`
  const domain = `${tag.toLowerCase()}.example`
  await importProspects(
    page,
    `prospection-${suffix}.xlsx`,
    [
      { company, civility: 'M.', first_name: 'Jean', last_name: `Echu${suffix}`, email: `jean@${domain}`, week: `S${String(past.week)}` },
      { company, civility: 'Mme', first_name: 'Claire', last_name: `Futur${suffix}`, email: `claire@${domain}`, week: `S${String(future.week)}` },
      { company, civility: 'M.', first_name: 'Hugo', last_name: `Relance${suffix}`, email: `hugo@${domain}`, relance1: 'x' },
      { company, civility: 'Mme', first_name: 'Emma', last_name: `Rdv${suffix}`, email: `emma@${domain}`, rdv: 'oui', referent: `Référente Suivi${suffix}` },
      { company, civility: 'Mme', first_name: 'Léa', last_name: `SansMail${suffix}` },
    ],
    { [past.week]: past.year, [future.week]: future.year },
  )

  await page.goto('/prospection')
  await page.getByRole('searchbox', { name: /Rechercher/ }).fill(tag)
  await expect(page).toHaveURL(new RegExp(`q=${tag}`))
  await expectCount(page, 'Tous', 5)
  await expectCount(page, 'Jamais vérifiés', 5)
  await expectCount(page, 'E-mail manquant', 1)
  await expectCount(page, 'E-mail non vérifié', 4)
  await expectCount(page, 'À contacter', 3)
  await expectCount(page, 'Échus', 1)
  await expectCount(page, 'Contactés', 2)
  await expectCount(page, 'Sans réponse', 1)
  await expectCount(page, 'Rendez-vous', 1)
  await expectCount(page, 'Opposition', 0)
  await expect(people(page).getByRole('listitem')).toHaveCount(5)

  await card(page, 'Échus').click()
  await expect(card(page, 'Échus')).toHaveAttribute('aria-pressed', 'true')
  await expect(page).toHaveURL(/segment=due/)
  await expect(people(page).getByRole('listitem')).toHaveCount(1)
  const due = people(page).getByRole('listitem').filter({ hasText: `Echu${suffix}` })
  await expect(due).toContainText('Échu')
  await expect(due).toContainText(`S${String(past.week)}`)
  await expect(due).toContainText('Emploi jamais vérifié')

  await card(page, 'Sans réponse').click()
  await expect(people(page).getByRole('listitem')).toHaveCount(1)
  await expect(people(page)).toContainText(`Relance${suffix}`)
  await expect(people(page)).toContainText('Relance 1')

  await card(page, 'Rendez-vous').click()
  await expect(people(page).getByRole('listitem')).toHaveCount(1)
  await expect(people(page)).toContainText(`Référent : Référente Suivi${suffix}`)

  // Reload keeps the segment and the search.
  await page.reload()
  await expect(card(page, 'Rendez-vous')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByRole('searchbox', { name: /Rechercher/ })).toHaveValue(tag)
  await expect(people(page).getByRole('listitem')).toHaveCount(1)

  // Combined filters: every counter follows them.
  await card(page, 'Tous').click()
  await page.getByRole('button', { name: 'Filtres' }).click()
  await page.getByRole('combobox', { name: 'Suivi de contact' }).selectOption({ label: 'Sans suivi' })
  await expectCount(page, 'Tous', 1)
  await expect(people(page)).toContainText(`SansMail${suffix}`)
  await expect(people(page)).toContainText('Pas d’e-mail principal')
  await page.getByRole('button', { name: 'Réinitialiser' }).click()
  await page.getByRole('searchbox', { name: /Rechercher/ }).fill(tag)
  await expectCount(page, 'Tous', 5)

  // Keyboard: ↓ to the second person, Enter opens them in the prospect editor over the list.
  await card(page, 'Contactés').click()
  await expect(people(page).getByRole('listitem')).toHaveCount(2)
  const links = people(page).getByRole('link')
  await links.first().focus()
  await page.keyboard.press('ArrowDown')
  await expect(links.nth(1)).toBeFocused()
  const second = (await links.nth(1).textContent()) ?? ''
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(/prospect=/)
  await expect(page.getByRole('dialog', { name: second })).toBeVisible()

  // Back closes the editor and returns to the list exactly as it was.
  await page.goBack()
  await expect(page.getByRole('dialog')).toBeHidden()
  await expect(page).toHaveURL(/\/prospection\?/)
  await expect(card(page, 'Contactés')).toHaveAttribute('aria-pressed', 'true')
  await expect(people(page).getByRole('listitem')).toHaveCount(2)
})

test('Add opens the prospect editor; import and export entry points are there', async ({ page }) => {
  await page.goto('/prospection')

  await page.getByRole('button', { name: 'Ajouter un prospect' }).click()
  await expect(page).toHaveURL(/prospect=new/)
  await expect(page.getByRole('dialog', { name: 'Nouveau prospect' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toBeHidden()
  await expect(page.getByRole('button', { name: 'Exporter Excel' })).toBeEnabled()
  await page.getByRole('link', { name: 'Importer Excel' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Importer un fichier Excel' })).toBeVisible()
})

for (const [width, height] of [
  [1440, 900],
  [1280, 800],
] as const) {
  for (const theme of ['dark', 'light'] as const) {
    test(`prospection screenshots (${theme}, ${String(width)} px)`, async ({ page }) => {
      await page.setViewportSize({ width, height })
      await useTheme(page, theme)
      await page.goto('/prospection?sort=planned_contact')
      await expect(people(page).getByRole('listitem').first()).toBeVisible()
      await expect(card(page, 'Tous').locator('.counter-card__count')).not.toHaveText('–')
      await page.mouse.move(0, 0)
      await page.screenshot({ path: `${SCREENSHOTS}/prospection-${theme}-${String(width)}.png`, animations: 'disabled' })
      await people(page).scrollIntoViewIfNeeded()
      await page.screenshot({
        path: `${SCREENSHOTS}/prospection-list-${theme}-${String(width)}.png`,
        animations: 'disabled',
      })
      const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth)
      expect(scrollWidth).toBeLessThanOrEqual(width)
    })
  }
}
