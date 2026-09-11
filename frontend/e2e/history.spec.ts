import { expect, type Locator, type Page, test } from '@playwright/test'

import { createCompany, importProspects, uniqueSuffix } from './data'
import { SCREENSHOTS } from './helpers'
import { signIn } from './session'

// Visible history (Task 19) against the real backend. The test imports its own person and creates its own company
// (names carry a `uniqueSuffix()` tag, I-81), edits the person in the Prospect editor, then reads the save back in the
// editor's history and in Home's recent edits.

test.beforeEach(async ({ page }) => {
  await signIn(page)
})

test.use({ viewport: { width: 1440, height: 900 } })

function region(scope: Locator, name: string) {
  return scope.getByRole('region', { name })
}

function entries(editor: Locator) {
  return editor.getByRole('list', { name: 'Historique du prospect' }).locator(':scope > li')
}

async function screenshots(page: Page, name: string, target: () => Locator) {
  for (const theme of ['dark', 'light'] as const) {
    await page.evaluate((value) => {
      window.localStorage.setItem('viper.theme', value)
    }, theme)
    await page.reload()
    await target().scrollIntoViewIfNeeded()
    await page.mouse.move(0, 0)
    await page.screenshot({ path: `${SCREENSHOTS}/${name}-${theme}-1440.png`, animations: 'disabled' })
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth)
    expect(overflow).toBeLessThanOrEqual(1440)
  }
}

test('an editor save reads back in the prospect history and on Home', async ({ page }) => {
  test.setTimeout(90_000)
  const suffix = uniqueSuffix()
  const tag = `HIS${suffix}`
  const domain = `${tag.toLowerCase()}.example`
  const file = `historique-${suffix}.xlsx`
  const person = `Paul Histoire${suffix}`
  await importProspects(page, file, [
    { company: `Transports ${tag}`, civility: 'M.', first_name: 'Paul', last_name: `Histoire${suffix}`, email: `paul@${domain}` },
  ])
  const employer = `Nouvel Employeur ${tag}`
  await createCompany(page, { display_name: employer })

  await page.goto('/prospection')
  await page.getByRole('searchbox', { name: /Rechercher/ }).fill(tag)
  await page.getByRole('list', { name: 'Prospects' }).getByRole('link', { name: person }).click()
  const editor = page.getByRole('dialog', { name: `M. ${person}` })

  // The imported person: provenance and an import entry.
  await expect(region(editor, 'Provenance')).toContainText(`par Import « ${file} »`)
  await expect(entries(editor)).toHaveCount(1)
  await expect(entries(editor).first()).toContainText(`Import « ${file} »`)
  await expect(entries(editor).first()).toContainText('Fiche créée')

  // One save: a new primary e-mail, another company, a contact stage.
  const emails = region(editor, 'E-mails')
  await emails.getByRole('button', { name: 'Ajouter un e-mail' }).click()
  await emails.getByRole('textbox', { name: 'Adresse e-mail' }).nth(1).fill(`p.histoire@${domain}`)
  await emails.getByRole('radio', { name: 'Principal' }).nth(1).check()
  await editor.getByRole('combobox', { name: /Entreprise/ }).fill(employer)
  await page.getByRole('option', { name: new RegExp(`^${employer}`) }).click()
  await region(editor, 'Suivi de contact').getByRole('combobox', { name: 'Étape' }).selectOption({ label: 'Contacté' })
  await editor.getByRole('button', { name: 'Enregistrer', exact: true }).click()
  await expect(editor.getByText('Prospect enregistré.')).toBeVisible()

  // Home first: its feed keeps the latest saves of the whole (shared) base.
  await page.goto('/')
  const feed = page.getByRole('region', { name: 'Dernières modifications' })
  const line = feed.getByRole('listitem').filter({ hasText: person })
  await expect(line).toContainText('Changement d’entreprise · E-mail principal modifié · E-mail ajouté · Suivi : Contacté')
  await expect(line).toContainText('Pilote E2E')
  await expect(line).not.toContainText(domain)
  await screenshots(page, 'history-home-feed', () => feed)

  await page.goBack()
  await expect(entries(editor)).toHaveCount(2)
  const saved = entries(editor).first()
  await expect(saved).toContainText('Vous')
  await expect(saved).toContainText('Interface')
  await expect(saved).toContainText('Changement d’entreprise')
  await expect(saved).toContainText(`Entreprise : Transports ${tag} → ${employer}`)
  await expect(saved).toContainText(`E-mail principal : paul@${domain} → p.histoire@${domain}`)
  await expect(saved).toContainText('Étape : Contacté')

  await screenshots(page, 'history-prospect-editor', () => region(page.getByRole('dialog').first(), 'Historique'))
})
