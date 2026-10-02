import { expect, type Page, test } from '@playwright/test'

import { createContactProspect, uniqueSuffix } from './data'
import { E2E_BOOKING_URL, E2E_OPENAI_PORT } from './env'
import { SCREENSHOTS, useTheme } from './helpers'
import { signIn } from './session'

// Contact page (Contact port S4) against the real backend: the operator's flow on a prospect the test creates and plans
// for this week through the API (I-81: every row carries the test's suffix, and a search narrows the page to them).
// Nothing is sent: the Toolbox is not connected in this project, so the dispatcher (S7) sends nothing; the full
// scenario with real sending (to the fake Toolbox) is e2e/contact-flow.spec.ts.

test.use({ viewport: { width: 1440, height: 900 } })

test.beforeEach(async ({ page }) => {
  await signIn(page)
})

function card(page: Page, label: string) {
  return page.getByRole('region', { name: 'Compteurs' }).getByRole('button', { name: new RegExp(`^${label}`) })
}

function mailTab(page: Page, step: string) {
  return page.getByRole('tablist', { name: 'Étapes de la séquence' }).getByRole('tab', { name: new RegExp(`^${step}`) })
}

function pad(value: number) {
  return String(value).padStart(2, '0')
}

// Tomorrow, as the date input's `YYYY-MM-DD` (the browser and the test share the machine's time zone).
function tomorrow(): string {
  const day = new Date(Date.now() + 24 * 60 * 60 * 1000)
  return `${String(day.getFullYear())}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`
}

// Screenshots of the page as it is, in both themes (the app's own theme switch: stored choice + reload), tall enough
// to hold the whole workbench (a full-page capture misplaces the fixed shell); no horizontal overflow at any width.
async function captureBoth(page: Page, name: string, widths: number[]) {
  for (const theme of ['dark', 'light'] as const) {
    await useTheme(page, theme)
    await page.reload()
    await expect(page.getByRole('tablist', { name: 'Étapes de la séquence' })).toBeVisible()
    for (const width of widths) {
      await page.setViewportSize({ width, height: 1250 })
      await page.screenshot({ path: `${SCREENSHOTS}/${name}-${theme}-${String(width)}.png`, animations: 'disabled' })
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
      expect(overflow, `no horizontal overflow at ${String(width)} px`).toBe(0)
    }
  }
  await useTheme(page, 'dark')
  await page.reload()
  await page.setViewportSize({ width: 1440, height: 900 })
  await expect(page.getByRole('tablist', { name: 'Étapes de la séquence' })).toBeVisible()
}

async function confirm(page: Page, title: RegExp, button: string | RegExp) {
  const dialog = page.getByRole('dialog', { name: title })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: button }).click()
  await expect(dialog).toBeHidden()
}

test('Exploitation became Contact: the old path redirects, the navigation names it', async ({ page }) => {
  await page.goto('/exploitation')
  await expect(page).toHaveURL(/\/contact$/)
  await expect(page.getByRole('heading', { level: 1, name: 'Contact' })).toBeVisible()
  const navigation = page.getByRole('navigation', { name: 'Navigation principale' })
  await expect(navigation.getByRole('link', { name: 'Contact' })).toHaveAttribute('aria-current', 'page')
})

test('operator flow: draft, validate, schedule, unschedule, edit back to draft, then « Réponse reçue » cancels', async ({
  page,
}) => {
  // ≈ 23 s alone (eight design captures with reloads): beyond the 30 s default under three workers.
  test.slow()
  const suffix = uniqueSuffix()
  const tag = `CE2E${suffix}`
  const email = `lina.${suffix}@contact-e2e.example`
  await createContactProspect(page, tag, { civility: 'ms', first_name: 'Lina', last_name: `Contact${suffix}`, email })

  await page.goto(`/contact?q=${tag}`)
  await expect(card(page, 'Premier contact').locator('.counter-card__count')).toHaveText('1')
  await expect(card(page, 'À traiter cette semaine').locator('.counter-card__count')).toHaveText('1')
  await expect(card(page, 'RDV pris').locator('.counter-card__count')).toHaveText('0')
  // « Cette semaine » is the default: the planned person is listed.
  const list = page.getByRole('list', { name: 'Prospects à contacter' })
  await expect(list.getByRole('listitem')).toHaveCount(1)

  await card(page, 'Premier contact').click()
  await expect(card(page, 'Premier contact')).toHaveAttribute('aria-pressed', 'true')
  await expect(page).toHaveURL(/counter=first_contact/)
  await expect(page.getByRole('combobox', { name: 'Semaine' })).toHaveValue('all')
  await expect(list.getByRole('listitem').first()).toContainText('Premier contact')
  await list.getByRole('link', { name: `Lina Contact${suffix}` }).click()

  // The workbench: the sheet on the left (its heading focused), the mail sequence on the right, Contact tab first.
  await expect(page.getByRole('heading', { level: 2, name: `Mme Lina Contact${suffix}` })).toBeFocused()
  await expect(page.getByRole('complementary', { name: 'Fiche du prospect' })).toContainText(email)
  await expect(mailTab(page, 'Contact')).toHaveAttribute('aria-selected', 'true')
  await expect(mailTab(page, 'Contact')).toContainText('Vide')
  const from = page.getByRole('textbox', { name: 'De' })
  if ((await from.inputValue()) === '') await from.fill('prospection@exemple.example')
  await expect(page.getByRole('textbox', { name: 'À', exact: true })).toHaveValue(email)
  await page.getByRole('textbox', { name: 'Objet' }).fill('Transport de vos marchandises (test)')
  await page.getByRole('textbox', { name: 'Corps' }).fill('Bonjour,\n\nCeci est un message synthétique de test.\n\nCordialement')
  await page.getByRole('button', { name: 'Créer le brouillon' }).click()
  await expect(mailTab(page, 'Contact')).toContainText('Brouillon')
  await expect(page.getByRole('status').filter({ hasText: 'Brouillon Contact créé.' })).toHaveCount(1)

  await captureBoth(page, 'contact-draft', [1440, 1280])

  await page.getByRole('button', { name: 'Valider…' }).click()
  await confirm(page, /Valider le message Contact/, 'Valider le message')
  await expect(mailTab(page, 'Contact')).toContainText('Validé')
  await expect(page.getByText(/prêt à être programmé/)).toBeFocused()

  // Schedule: no default time — date and time are typed.
  await page.getByLabel('Date d’envoi').fill(tomorrow())
  await page.getByLabel('Heure').fill('09:30')
  await page.setViewportSize({ width: 1440, height: 1250 })
  await page.screenshot({ path: `${SCREENSHOTS}/contact-validated-dark-1440.png`, animations: 'disabled' })
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.getByRole('button', { name: 'Programmer…' }).click()
  // Automatic sending inactive in this project (S9): « Programmer quand même » (« Programmer l’envoi » once it is active).
  await confirm(page, /Programmer le message Contact/, /^Programmer (l’envoi|quand même)$/)
  await expect(mailTab(page, 'Contact')).toContainText('Programmé')
  await expect(page.getByText(/Programmé pour le/)).toBeVisible()

  await page.getByRole('button', { name: 'Déprogrammer' }).click()
  await expect(mailTab(page, 'Contact')).toContainText('Validé')

  // An edit of a validated message says it goes back to draft, and does.
  await page.getByRole('textbox', { name: 'Objet' }).fill('Transport de vos marchandises (test, v2)')
  await expect(page.getByRole('note')).toContainText('l’enregistrer le repasse en Brouillon')
  await page.getByRole('button', { name: 'Enregistrer', exact: true }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Message Contact enregistré et repassé en Brouillon : à revalider.' })).toHaveCount(1)
  await expect(mailTab(page, 'Contact')).toContainText('Brouillon')

  // A sequence-closing state, chosen by hand and confirmed, cancels the unsent message and locks the editor.
  await page.getByRole('combobox', { name: 'État' }).selectOption('response_received')
  await page.getByRole('button', { name: 'Enregistrer le suivi' }).click()
  await confirm(page, /Passer à « Réponse reçue »/, 'Confirmer « Réponse reçue »')
  await expect(page.getByRole('status').filter({ hasText: 'Suivi enregistré. 1 message non envoyé annulé.' })).toHaveCount(1)
  await expect(mailTab(page, 'Contact')).toContainText('Annulé')
  await expect(page.getByText(/Séquence close par l’état « Réponse reçue »/)).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'Objet' })).toHaveAttribute('readonly', '')

  await captureBoth(page, 'contact-locked', [1440])

  // Back to the list: the person left « Premier contact » (the state moved, nothing to prepare any more).
  await page.getByRole('button', { name: 'Retour à la liste' }).click()
  await expect(card(page, 'Premier contact').locator('.counter-card__count')).toHaveText('0')
  await expect(page.getByText('Aucun prospect ne correspond à ces critères.')).toBeVisible()
  // « Retour à la liste » went back to the list's entry: going forward reopens the workbench, not Back.
  await page.goForward()
  await expect(page.getByRole('tablist', { name: 'Étapes de la séquence' })).toBeVisible()
})

test('unsaved text asks before leaving the prospect', async ({ page }) => {
  const suffix = uniqueSuffix()
  const tag = `CG2E${suffix}`
  const { id } = await createContactProspect(page, tag, {
    civility: 'mr',
    first_name: 'Noé',
    last_name: `Garde${suffix}`,
    email: `noe.${suffix}@contact-e2e.example`,
  })
  await page.goto(`/contact?q=${tag}&prospect=${id}`)
  await page.getByRole('textbox', { name: 'Objet' }).fill('Brouillon non enregistré')
  // Switching tabs keeps the text (marked unsaved); leaving the prospect asks.
  await mailTab(page, 'R1').click()
  await expect(mailTab(page, 'Contact')).toContainText('modifications non enregistrées')
  await mailTab(page, 'Contact').click()
  await expect(page.getByRole('textbox', { name: 'Objet' })).toHaveValue('Brouillon non enregistré')
  await page.getByRole('button', { name: 'Retour à la liste' }).click()
  const guard = page.getByRole('dialog', { name: 'Modifications non enregistrées' })
  await expect(guard).toBeVisible()
  await guard.getByRole('button', { name: 'Rester sur ce prospect' }).click()
  await expect(page.getByRole('textbox', { name: 'Objet' })).toHaveValue('Brouillon non enregistré')
  await page.getByRole('button', { name: 'Retour à la liste' }).click()
  await guard.getByRole('button', { name: 'Quitter sans enregistrer' }).click()
  await expect(page.getByRole('list', { name: 'Prospects à contacter' })).toBeVisible()
})

for (const theme of ['dark', 'light'] as const) {
  test(`contact list screenshot (${theme})`, async ({ page }) => {
    const suffix = uniqueSuffix()
    const tag = `CS2E${suffix}`
    await createContactProspect(page, tag, { civility: 'ms', first_name: 'Maëlle', last_name: `Liste${suffix}`, email: `maelle.${suffix}@contact-e2e.example` })
    await createContactProspect(page, `${tag}B`, { civility: 'mr', first_name: 'Hugo', last_name: `Liste${suffix}`, email: `hugo.${suffix}@contact-e2e.example` })
    await useTheme(page, theme)
    await page.goto(`/contact?q=Liste${suffix}`)
    await expect(page.getByRole('list', { name: 'Prospects à contacter' }).getByRole('listitem')).toHaveCount(2)
    for (const width of [1440, 1280]) {
      await page.setViewportSize({ width, height: 900 })
      await page.screenshot({ path: `${SCREENSHOTS}/contact-list-${theme}-${String(width)}.png`, animations: 'disabled' })
    }
  })
}

// AI drafting (S5) against the fake OpenAI server started by playwright.config.ts (e2e/fake-openai.ts): never OpenAI.
// The draft lands as a Brouillon with the AI note, the « consigne » and the booking link reach the model, no e-mail
// address does; a regeneration of a validated message is confirmed and puts it back to Brouillon; a failing AI is said.
test('AI drafting: generate with a « consigne », regenerate after validation, a failure is said', async ({ page }) => {
  const suffix = uniqueSuffix()
  const tag = `CA2E${suffix}`
  const email = `ines.${suffix}@contact-e2e.example`
  const { id, company } = await createContactProspect(page, tag, { civility: 'ms', first_name: 'Inès', last_name: `Redac${suffix}`, email })
  await page.goto(`/contact?q=${tag}&prospect=${id}`)

  const generate = page.getByRole('button', { name: 'Générer avec l’IA' })
  await expect(generate).toBeEnabled()
  await page.getByRole('button', { name: 'Consigne' }).click()
  await page.getByRole('textbox', { name: 'Consigne pour l’IA (facultatif)' }).fill('Plus court')
  await generate.click()

  await expect(page.getByRole('textbox', { name: 'Objet' })).toHaveValue(`Agents IA pour ${company}`)
  const body = page.getByRole('textbox', { name: 'Corps' })
  await expect(body).toHaveValue(new RegExp(`^Bonjour Madame Redac${suffix},`))
  await expect(body).toHaveValue(/\(Consigne appliquée : Plus court\)/)
  await expect(body).toHaveValue(new RegExp(E2E_BOOKING_URL.replaceAll('.', '\\.')))
  await expect(page.getByText('Rédigé par l’IA — à relire avant de valider.')).toBeVisible()
  await expect(page.getByText(/Modèle fake-e2e-model-snapshot · prompt contact-mail-fr-2026-09-v1/)).toBeVisible()
  await expect(mailTab(page, 'Contact')).toContainText('Brouillon')

  // What reached the model: the step and the facts, never the e-mail address.
  const received = (await (await page.request.get(`http://127.0.0.1:${String(E2E_OPENAI_PORT)}/requests`)).json()) as {
    input: string
    store: boolean
  }[]
  const mine = received.filter((request) => request.input.includes(`Redac${suffix}`))
  expect(mine).toHaveLength(1)
  expect(mine[0]?.input).toContain('Étape : Contact')
  expect(mine[0]?.input).not.toContain(email)
  expect(mine[0]?.store).toBe(false)

  // Design review, both themes: the generated draft, then the « consigne » open (tall enough for the action bar); no
  // horizontal overflow down to 1280 px.
  for (const theme of ['dark', 'light'] as const) {
    await useTheme(page, theme)
    await page.reload()
    await expect(page.getByText('Rédigé par l’IA — à relire avant de valider.')).toBeVisible()
    for (const width of [1440, 1280]) {
      await page.setViewportSize({ width, height: 1500 })
      await page.screenshot({ path: `${SCREENSHOTS}/contact-ai-draft-${theme}-${String(width)}.png`, animations: 'disabled' })
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
      expect(overflow, `no horizontal overflow at ${String(width)} px`).toBe(0)
    }
    await page.setViewportSize({ width: 1440, height: 1500 })
    await page.getByRole('button', { name: 'Consigne' }).click()
    await page.getByRole('textbox', { name: 'Consigne pour l’IA (facultatif)' }).fill('Insister sur la logistique')
    await page.screenshot({ path: `${SCREENSHOTS}/contact-ai-consigne-${theme}-1440.png`, animations: 'disabled' })
  }
  await useTheme(page, 'dark')
  await page.reload()
  await page.setViewportSize({ width: 1440, height: 900 })
  await expect(page.getByText('Rédigé par l’IA — à relire avant de valider.')).toBeVisible()

  // Validate, then regenerate: confirmed first, back to Brouillon.
  await page.getByRole('button', { name: 'Valider…' }).click()
  await confirm(page, /Valider le message Contact/, 'Valider le message')
  await expect(mailTab(page, 'Contact')).toContainText('Validé')
  await page.getByRole('button', { name: 'Régénérer avec l’IA' }).click()
  const dialog = page.getByRole('dialog', { name: 'Régénérer le message Contact ?' })
  await expect(dialog).toContainText('Le message repassera en Brouillon')
  await dialog.getByRole('button', { name: 'Remplacer par la proposition' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Il est repassé en Brouillon : à revalider.' })).toHaveCount(1)
  await expect(mailTab(page, 'Contact')).toContainText('Brouillon')

  // A failing AI (the fake answers 503 to this « consigne »): said on screen, the saved text stays.
  const saved = await body.inputValue()
  await page.getByRole('button', { name: 'Consigne' }).click()
  await page.getByRole('textbox', { name: 'Consigne pour l’IA (facultatif)' }).fill('FAKE_AI_FAIL')
  await page.getByRole('button', { name: 'Régénérer avec l’IA' }).click()
  await page.getByRole('dialog', { name: 'Régénérer le message Contact ?' }).getByRole('button', { name: 'Remplacer par la proposition' }).click()
  await expect(page.getByRole('alert')).toContainText('Le service d’IA a échoué ou est injoignable. Rien n’a été modifié')
  await expect(body).toHaveValue(saved)
})
