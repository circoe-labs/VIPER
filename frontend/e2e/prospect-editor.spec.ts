import { expect, type Locator, type Page, test } from '@playwright/test'

import { importProspects, uniqueSuffix } from './data'
import { SCREENSHOTS } from './helpers'
import { signIn } from './session'

// Prospect editor (Task 15) against the real backend. Every test imports or creates its own synthetic people (names and
// company carry a `uniqueSuffix()` tag) and narrows Prospection to them with that tag, so counts are its own (I-81).

test.beforeEach(async ({ page }) => {
  await signIn(page)
})

test.use({ viewport: { width: 1440, height: 900 } })

function card(page: Page, label: string) {
  return page.getByRole('region', { name: 'Compteurs' }).getByRole('button', { name: new RegExp(`^${label}`) })
}

async function expectCount(page: Page, label: string, count: number) {
  await expect(card(page, label).locator('.counter-card__count')).toHaveText(String(count))
}

function people(page: Page) {
  return page.getByRole('list', { name: 'Prospects' })
}

async function searchTag(page: Page, tag: string) {
  await page.goto('/prospection')
  await page.getByRole('searchbox', { name: /Rechercher/ }).fill(tag)
  await expect(page).toHaveURL(new RegExp(`q=${tag}`))
}

function region(scope: Locator, name: string) {
  return scope.getByRole('region', { name })
}

test('verify, add a primary e-mail, plan the contact, then Save & Next through the filtered queue', async ({ page }) => {
  const suffix = uniqueSuffix()
  const tag = `PED${suffix}`
  const company = `Transports ${tag}`
  await importProspects(page, `editeur-${suffix}.xlsx`, [
    { company, civility: 'M.', first_name: 'Jean', last_name: `Arnaud${suffix}`, email: `jean@${tag.toLowerCase()}.example` },
    { company, civility: 'Mme', first_name: 'Claire', last_name: `Bertin${suffix}`, email: `claire@${tag.toLowerCase()}.example` },
    { company, civility: 'M.', first_name: 'Hugo', last_name: `Caron${suffix}`, mobile: '06 00 00 00 03' },
  ])

  await searchTag(page, tag)
  await card(page, 'Jamais vérifiés').click()
  await expect(people(page).getByRole('listitem')).toHaveCount(3)
  await people(page).getByRole('link', { name: `Jean Arnaud${suffix}` }).click()

  const editor = page.getByRole('dialog', { name: `M. Jean Arnaud${suffix}` })
  await expect(editor).toHaveAccessibleDescription('Prospect 1 sur 3 · Jamais vérifiés')
  const verification = region(editor, 'Vérification de l’emploi')
  await expect(verification).toContainText('Valeurs importées, jamais vérifiées')
  await verification.getByRole('button', { name: 'Vérifié aujourd’hui' }).click()

  const emails = region(editor, 'E-mails')
  await emails.getByRole('button', { name: 'Ajouter un e-mail' }).click()
  await emails.getByRole('textbox', { name: 'Adresse e-mail' }).nth(1).fill(`j.arnaud@${tag.toLowerCase()}.example`)
  await emails.getByRole('radio', { name: 'Principal' }).nth(1).check()

  const tracking = region(editor, 'Suivi de contact')
  await tracking.getByRole('button', { name: 'Dans 1 semaine' }).click()
  await tracking.getByRole('combobox', { name: 'Étape' }).selectOption({ label: 'Contacté' })
  await expect(tracking).toContainText('Semaine')

  await editor.getByRole('button', { name: 'Enregistrer et suivant' }).click()

  // Arnaud left « Jamais vérifiés » (the list behind now counts 2); the queue keeps the order it was opened with.
  const next = page.getByRole('dialog', { name: `Mme Claire Bertin${suffix}` })
  await expect(next).toBeVisible()
  await expect(next).toHaveAccessibleDescription('Prospect 2 sur 3 · Jamais vérifiés')
  await expectCount(page, 'Jamais vérifiés', 2)
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toBeHidden()

  await card(page, 'Tous').click()
  const saved = people(page).getByRole('listitem').filter({ hasText: `Arnaud${suffix}` })
  await expect(saved).toContainText(`j.arnaud@${tag.toLowerCase()}.example`)
  await expect(saved).toContainText('Vérifié le')
  await expect(saved).toContainText('Contacté')
})

test('add a new prospect with a company created inline', async ({ page }) => {
  const suffix = uniqueSuffix()
  const tag = `PEN${suffix}`
  const company = `Société ${tag}`
  await page.goto('/prospection')
  await page.getByRole('button', { name: 'Ajouter un prospect' }).click()

  const editor = page.getByRole('dialog', { name: 'Nouveau prospect' })
  await editor.getByRole('textbox', { name: 'Prénom' }).fill('Nina')
  await editor.getByRole('textbox', { name: 'Nom', exact: true }).fill(`Nouvelle${suffix}`)
  const picker = editor.getByRole('combobox', { name: /Entreprise/ })
  await picker.fill(company)
  await editor.getByRole('option', { name: `Créer l’entreprise « ${company} »` }).click()

  const companyEditor = page.getByRole('dialog', { name: 'Nouvelle entreprise' })
  await expect(companyEditor.getByRole('textbox', { name: /Nom de l’entreprise/ })).toHaveValue(company)
  await companyEditor.getByRole('button', { name: 'Enregistrer' }).click()
  const savedCompany = page.getByRole('dialog', { name: company })
  await expect(savedCompany.getByText('Entreprise enregistrée.')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(savedCompany).toBeHidden()
  await expect(picker).toHaveValue(company)

  await region(editor, 'E-mails').getByRole('textbox', { name: 'Adresse e-mail' }).fill(`nina@${tag.toLowerCase()}.example`)
  await expect(region(editor, 'Provenance').getByRole('textbox', { name: /Contexte de collecte/ })).toHaveValue(
    'Saisie manuelle — prospection B2B',
  )
  await editor.getByRole('button', { name: 'Enregistrer', exact: true }).click()

  const created = page.getByRole('dialog', { name: `Nina Nouvelle${suffix}` })
  await expect(created.getByText('Prospect enregistré.')).toBeVisible()
  await expect(region(created, 'Provenance')).toContainText('Saisie manuelle')
  await page.keyboard.press('Escape')

  await searchTag(page, tag)
  await expectCount(page, 'Tous', 1)
  await expect(people(page)).toContainText(`Nina Nouvelle${suffix}`)
  await expect(people(page)).toContainText(company)
})

test('an opposition recorded with its reason is counted under Opposition', async ({ page }) => {
  const suffix = uniqueSuffix()
  const tag = `PEO${suffix}`
  await importProspects(page, `opposition-${suffix}.xlsx`, [
    { company: `Transports ${tag}`, civility: 'Mme', first_name: 'Léa', last_name: `Oppose${suffix}`, email: `lea@${tag.toLowerCase()}.example` },
  ])

  await searchTag(page, tag)
  await expectCount(page, 'Opposition', 0)
  await people(page).getByRole('link', { name: `Léa Oppose${suffix}` }).click()
  const editor = page.getByRole('dialog', { name: `Mme Léa Oppose${suffix}` })
  await region(editor, 'Opposition').getByRole('button', { name: 'Enregistrer une opposition…' }).click()
  const confirm = page.getByRole('dialog', { name: 'Enregistrer une opposition ?' })
  await confirm.getByRole('textbox', { name: /Motif/ }).fill('Demande de l’intéressée (synthétique)')
  await confirm.getByRole('button', { name: 'Enregistrer l’opposition' }).click()

  await expect(region(editor, 'Opposition')).toContainText('Ne pas contacter')
  await expect(region(editor, 'Opposition')).toContainText('Motif : Demande de l’intéressée (synthétique)')
  await page.keyboard.press('Escape')
  await expectCount(page, 'Opposition', 1)
  await expectCount(page, 'À contacter', 0)
  await card(page, 'Opposition').click()
  await expect(people(page)).toContainText('Ne pas contacter')
})

const VIEWPORTS = [
  [1440, 900],
  [1280, 800],
] as const

async function screenshots(page: Page, state: string) {
  for (const theme of ['dark', 'light'] as const) {
    await page.evaluate((value) => {
      window.localStorage.setItem('viper.theme', value)
    }, theme)
    for (const [width, height] of VIEWPORTS) {
      await page.setViewportSize({ width, height })
      await page.reload()
      const editor = page.getByRole('dialog').first()
      await expect(editor.getByRole('textbox', { name: 'Prénom' })).toBeVisible()
      await expect(editor.getByRole('region', { name: 'Entreprise' })).not.toContainText('Chargement')
      await page.mouse.move(0, 0)
      await page.screenshot({ path: `${SCREENSHOTS}/prospect-editor-${state}-${theme}-${String(width)}.png`, animations: 'disabled' })
      await editor.getByRole('region', { name: 'Téléphones' }).scrollIntoViewIfNeeded()
      await page.screenshot({ path: `${SCREENSHOTS}/prospect-editor-${state}-aliases-${theme}-${String(width)}.png`, animations: 'disabled' })
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth)
      expect(overflow).toBeLessThanOrEqual(width)
    }
  }
}

test('editor screenshots: imported values to verify, then verified (dark/light, 1440 and 1280 px)', async ({ page }) => {
  test.setTimeout(90_000)
  const suffix = uniqueSuffix()
  const tag = `PES${suffix}`
  await importProspects(page, `captures-${suffix}.xlsx`, [
    {
      company: `Transports ${tag}`,
      civility: 'M.',
      first_name: 'Paul',
      last_name: `Capture${suffix}`,
      job: 'Responsable exploitation (synthétique)',
      email: `paul@${tag.toLowerCase()}.example`,
      mobile: '06 00 00 00 07',
    },
  ])
  await searchTag(page, tag)
  await people(page).getByRole('link', { name: `Paul Capture${suffix}` }).click()
  await expect(page).toHaveURL(/prospect=/)

  await screenshots(page, 'to-verify')

  const editor = page.getByRole('dialog').first()
  await editor.getByRole('radio', { name: 'Actif', exact: true }).check()
  await editor.getByRole('button', { name: 'Vérifié aujourd’hui' }).click()
  await region(editor, 'E-mails').getByRole('button', { name: 'Vérifié', exact: true }).click()
  await region(editor, 'Téléphones').getByRole('button', { name: 'Vérifié', exact: true }).click()
  await region(editor, 'Suivi de contact').getByRole('button', { name: 'Dans 1 semaine' }).click()
  await editor.getByRole('button', { name: 'Enregistrer', exact: true }).click()
  await expect(editor.getByText('Prospect enregistré.')).toBeVisible()
  await expect(region(editor, 'Vérification de l’emploi')).toContainText('Vérifié le')

  await screenshots(page, 'verified')
})
