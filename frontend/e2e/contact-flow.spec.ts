import { expect, type Page, test } from '@playwright/test'

import { createContactProspect, importProspects, isoWeekOf, post, uniqueSuffix } from './data'
import { E2E_TOOLBOX_PORT } from './env'
import { SCREENSHOTS, useTheme } from './helpers'
import { signIn } from './session'

// The whole Contact lot, as an operator drives it (Contact port S7), against the real backend and the local fakes
// (OpenAI: e2e/fake-openai.ts, CIRCOE Toolbox: e2e/fake-toolbox.ts — never a real service, P6): import → plan the
// week in Prospection → connect the Toolbox → Contact page → AI draft → edit → validate (Infomaniak draft) → schedule
// → the API's dispatcher sends it (one `send_draft`) → Envoyé, read-only → the person chooses « Contacté » and applies
// the suggested cadence → R1 drafted, validated, scheduled → « Réponse reçue » cancels R1 and its Infomaniak draft is
// deleted. Then a send whose outcome is unknown: locked, never resent, settled by a person. It runs in its own project
// after the Toolbox spec (the connection is one per server) and forgets the connection at the end.

test.describe.configure({ mode: 'serial' })
test.use({ viewport: { width: 1440, height: 900 } })

const FAKE = `http://127.0.0.1:${String(E2E_TOOLBOX_PORT)}`

interface FakeDrafts {
  drafts: { id: string; subject: string }[]
  deleted: string[]
  sent: string[]
}

async function fakeDrafts(page: Page): Promise<FakeDrafts> {
  return (await (await page.request.get(`${FAKE}/drafts`)).json()) as FakeDrafts
}

async function fakeMode(page: Page, mode: { sendAnswerStatus?: number; listFails?: boolean }) {
  expect((await page.request.post(`${FAKE}/mode`, { data: mode })).ok()).toBe(true)
}

async function draftIdOf(page: Page, subject: string): Promise<string> {
  const draft = (await fakeDrafts(page)).drafts.find((entry) => entry.subject === subject)
  expect(draft, `the fake Toolbox holds the draft « ${subject} »`).toBeDefined()
  return draft?.id ?? ''
}

function mailTab(page: Page, step: string) {
  return page.getByRole('tablist', { name: 'Étapes de la séquence' }).getByRole('tab', { name: new RegExp(`^${step}`) })
}

async function confirm(page: Page, title: RegExp, button: string) {
  const dialog = page.getByRole('dialog', { name: title })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: button }).click()
  await expect(dialog).toBeHidden()
}

const pad = (value: number) => String(value).padStart(2, '0')
const dayOf = (at: Date) => `${String(at.getFullYear())}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`
const timeOf = (at: Date) => `${pad(at.getHours())}:${pad(at.getMinutes())}`

// The next whole minute at least 20 s ahead: the picker has minute precision.
function nextMinute(): Date {
  const at = new Date(Date.now() + 60_000)
  at.setSeconds(0, 0)
  if (at.getTime() - Date.now() < 20_000) at.setTime(at.getTime() + 60_000)
  return at
}

async function capture(page: Page, name: string, ready: () => Promise<void>) {
  for (const theme of ['dark', 'light'] as const) {
    await useTheme(page, theme)
    await page.reload()
    await ready()
    await page.setViewportSize({ width: 1440, height: 1250 })
    await page.screenshot({ path: `${SCREENSHOTS}/${name}-${theme}-1440.png`, animations: 'disabled' })
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    expect(overflow, 'no horizontal overflow at 1440 px').toBe(0)
  }
  await useTheme(page, 'dark')
  await page.reload()
  await page.setViewportSize({ width: 1440, height: 900 })
  await ready()
}

test.beforeEach(async ({ page }) => {
  await signIn(page)
})

test.afterAll(async ({ browser }) => {
  // Leave the server as found: no failure mode on the fake, no Toolbox connection.
  const page = await browser.newPage()
  await page.request.post(`${FAKE}/mode`, { data: {} })
  await signIn(page)
  await page.goto('/settings/connections')
  await expect(page.getByRole('region', { name: 'CIRCOE Toolbox' })).toBeVisible()
  const forget = page.getByRole('button', { name: 'Oublier la connexion…' })
  if (await forget.isVisible()) {
    await forget.click()
    await confirm(page, /Oublier la connexion à la Toolbox/, 'Oublier la connexion')
  }
  await page.close()
})

test('the operator scenario: import, plan, draft with the AI, validate, schedule, sent, cadence, answer', async ({ page }) => {
  // Waits for a real minute boundary and the dispatcher's pass: up to ~2 min of the 6 allowed.
  test.setTimeout(360_000)
  const suffix = uniqueSuffix()
  const tag = `FLX${suffix}`
  const lastName = `Flux${suffix}`

  // 1. Import (the real import API, a synthetic workbook): one person, no week yet.
  await importProspects(page, `contact-flux-${suffix}.xlsx`, [
    { company: `Transports ${tag}`, civility: 'Mme', first_name: 'Alice', last_name: lastName, email: `alice.${suffix}@flux-e2e.example` },
  ])

  // 2. Prospection: plan the first contact for this week from the list.
  await page.goto(`/prospection?q=${tag}`)
  const row = page.getByRole('list', { name: 'Prospects' }).getByRole('listitem').filter({ hasText: lastName })
  await expect(row).toHaveCount(1)
  await row.getByRole('button', { name: /^Planifier la semaine de/ }).click()
  const popover = page.getByRole('dialog', { name: /^Prochaine semaine de Alice/ })
  await popover.getByRole('button', { name: 'Cette semaine' }).click()
  const week = `S${pad(isoWeekOf(new Date()).week)}`
  await popover.getByRole('button', { name: `Enregistrer ${week}` }).click()
  await expect(popover).toBeHidden()
  await expect(row).toContainText(week)

  // 3. Paramètres › Connexions: connect the Toolbox; the scheduled sending becomes active.
  await page.goto('/settings/connections')
  await page.getByRole('button', { name: 'Connecter la Toolbox' }).click()
  await expect(page.getByRole('status').filter({ hasText: /CIRCOE Toolbox connectée jusqu’au/ })).toHaveCount(1)
  const toolbox = page.getByRole('region', { name: 'CIRCOE Toolbox' })
  await expect(toolbox).toContainText('Envoi programmé')
  await expect(toolbox).toContainText('Actif')
  await capture(page, 'settings-connections-dispatch', async () => {
    await expect(page.getByRole('region', { name: 'CIRCOE Toolbox' })).toContainText('Actif')
  })

  // 4. Contact: the planned person is in this week's list.
  await page.goto(`/contact?q=${tag}`)
  await page.getByRole('list', { name: 'Prospects à contacter' }).getByRole('link', { name: `Alice ${lastName}` }).click()
  await expect(mailTab(page, 'Contact')).toHaveAttribute('aria-selected', 'true')

  // 5. The AI drafts (fake OpenAI), the person reviews and edits, saves, validates: the Infomaniak draft is created.
  await page.getByRole('button', { name: 'Générer avec l’IA' }).click()
  const subject = page.getByRole('textbox', { name: 'Objet' })
  await expect(subject).toHaveValue(/^Agents IA pour /)
  const reviewed = `${await subject.inputValue()} (relu)`
  await subject.fill(reviewed)
  await page.getByRole('button', { name: 'Enregistrer', exact: true }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Message Contact enregistré.' })).toHaveCount(1)
  await page.getByRole('button', { name: 'Valider…' }).click()
  await confirm(page, /Valider le message Contact/, 'Valider le message')
  await expect(page.getByText('Brouillon créé dans Infomaniak.')).toBeVisible()
  const contactDraft = await draftIdOf(page, reviewed)

  // 6. Schedule at the next minute: the confirmation promises an automatic send (the server really sends).
  const at = nextMinute()
  await page.getByLabel('Date d’envoi').fill(dayOf(at))
  await page.getByLabel('Heure').fill(timeOf(at))
  await page.getByRole('button', { name: 'Programmer…' }).click()
  const scheduling = page.getByRole('dialog', { name: /Programmer le message Contact/ })
  await expect(scheduling).toContainText('Le mail partira automatiquement à cette date')
  await expect(scheduling).toContainText('S’il ne peut pas partir dans les 6 heures qui suivent')
  await scheduling.getByRole('button', { name: 'Programmer l’envoi' }).click()
  await expect(page.getByText(/^Programmé : le mail partira automatiquement le /)).toBeVisible()
  expect((await fakeDrafts(page)).sent).not.toContain(contactDraft)

  // 7. The API's dispatcher sends it at the chosen minute; the page shows it without a reload.
  await expect(mailTab(page, 'Contact')).toContainText('Envoyé', { timeout: 150_000 })
  // Said by the persistent live region, whatever the editor shows.
  await expect(page.getByRole('status').filter({ hasText: 'Message Contact envoyé.' })).toHaveCount(1)
  expect((await fakeDrafts(page)).sent.filter((id) => id === contactDraft)).toHaveLength(1)
  await expect(page.getByText(/^Envoyé le /)).toBeVisible()
  await expect(page.getByText('Message envoyé : il reste consultable mais ne peut plus être modifié.')).toBeVisible()
  await expect(subject).toHaveAttribute('readonly', '')
  // Sending changed no state: still no state badge, the person decides.
  await expect(page.getByRole('combobox', { name: 'État' })).toHaveValue('neutral')
  await capture(page, 'contact-sent', async () => {
    await expect(mailTab(page, 'Contact')).toContainText('Envoyé')
  })

  // 8. The person chooses « Contacté »; the cadence (+2 weeks, R1) is suggested, applied by hand.
  await page.getByRole('combobox', { name: 'État' }).selectOption('contacted')
  await page.getByRole('button', { name: 'Enregistrer le suivi' }).click()
  await expect(page.getByRole('status').filter({ hasText: /^Suivi enregistré/ })).toHaveCount(1)
  const r1Week = `S${pad(isoWeekOf(new Date(Date.now() + 14 * 86_400_000)).week)}`
  await page.getByRole('button', { name: `Appliquer la cadence : ${r1Week} (relance après Contacté)` }).click()
  await page.getByRole('button', { name: 'Enregistrer le suivi' }).click()
  await expect(page.getByRole('complementary', { name: 'Fiche du prospect' })).toContainText(r1Week)

  // 9. R1: drafted, validated (Infomaniak draft), scheduled for tomorrow.
  await mailTab(page, 'R1').click()
  const r1Subject = `Relance ${tag}`
  await page.getByRole('textbox', { name: 'Objet' }).fill(r1Subject)
  await page.getByRole('textbox', { name: 'Corps' }).fill('Bonjour,\n\nJe me permets de revenir vers vous (message synthétique).\n\nCordialement')
  await page.getByRole('button', { name: 'Créer le brouillon' }).click()
  await expect(mailTab(page, 'R1')).toContainText('Brouillon')
  await page.getByRole('button', { name: 'Valider…' }).click()
  await confirm(page, /Valider le message R1/, 'Valider le message')
  await expect(page.getByText('Brouillon créé dans Infomaniak.')).toBeVisible()
  const r1Draft = await draftIdOf(page, r1Subject)
  await page.getByLabel('Date d’envoi').fill(dayOf(new Date(Date.now() + 86_400_000)))
  await page.getByLabel('Heure').fill('09:30')
  await page.getByRole('button', { name: 'Programmer…' }).click()
  await confirm(page, /Programmer le message R1/, 'Programmer l’envoi')
  await expect(mailTab(page, 'R1')).toContainText('Programmé')

  // 10. An answer arrives: « Réponse reçue » cancels R1, and its Infomaniak draft is deleted by the cleanup worker.
  await page.getByRole('combobox', { name: 'État' }).selectOption('response_received')
  await page.getByRole('button', { name: 'Enregistrer le suivi' }).click()
  await confirm(page, /Passer à « Réponse reçue »/, 'Confirmer « Réponse reçue »')
  await expect(page.getByRole('status').filter({ hasText: 'Suivi enregistré. 1 message non envoyé annulé.' })).toHaveCount(1)
  await expect(mailTab(page, 'R1')).toContainText('Annulé')
  await expect(mailTab(page, 'Contact')).toContainText('Envoyé')
  await expect.poll(async () => (await fakeDrafts(page)).deleted.includes(r1Draft), { timeout: 15_000 }).toBe(true)
  expect((await fakeDrafts(page)).sent).not.toContain(r1Draft)

  // The list says it per step.
  await page.getByRole('button', { name: 'Retour à la liste' }).click()
  await page.getByRole('combobox', { name: 'Semaine' }).selectOption('all')
  await page.getByRole('combobox', { name: 'État' }).selectOption('response_received')
  const item = page.getByRole('list', { name: 'Prospects à contacter' }).getByRole('listitem').filter({ hasText: lastName })
  await expect(item).toContainText(/Contact\s*Envoyé/)
  await expect(item).toContainText(/R1\s*Annulé/)
})

test('a send whose outcome is unknown is never resent and a person settles it', async ({ page }) => {
  test.setTimeout(120_000)
  const suffix = uniqueSuffix()
  const tag = `FLU${suffix}`
  const { id } = await createContactProspect(page, tag, {
    civility: 'mr',
    first_name: 'Hugo',
    last_name: `Incertain${suffix}`,
    email: `hugo.${suffix}@flux-e2e.example`,
  })
  await page.goto(`/settings/connections`)
  const toolbox = page.getByRole('region', { name: 'CIRCOE Toolbox' })
  if (!(await toolbox.textContent())?.includes('Valable jusqu’au')) {
    await page.getByRole('button', { name: 'Connecter la Toolbox' }).click()
    await expect(page.getByRole('status').filter({ hasText: /CIRCOE Toolbox connectée jusqu’au/ })).toHaveCount(1)
  }

  await page.goto(`/contact?prospect=${id}`)
  const subject = `Incertain ${tag}`
  await page.getByRole('textbox', { name: 'Objet' }).fill(subject)
  await page.getByRole('textbox', { name: 'Corps' }).fill('Bonjour,\n\nMessage synthétique de test.\n\nCordialement')
  await page.getByRole('button', { name: 'Créer le brouillon' }).click()
  await page.getByRole('button', { name: 'Valider…' }).click()
  await confirm(page, /Valider le message Contact/, 'Valider le message')
  await expect(page.getByText('Brouillon créé dans Infomaniak.')).toBeVisible()
  const draft = await draftIdOf(page, subject)

  // The Toolbox sends, then answers 502 (the outcome is unknown to VIPER), and its draft list is unreadable.
  await fakeMode(page, { sendAnswerStatus: 502, listFails: true })
  try {
    // Scheduled a few seconds ahead through the API (the picker has minute precision).
    await post(page, `/api/prospects/${id}/messages/contact/schedule`, {
      expected_revision: 1,
      scheduled_at: new Date(Date.now() + 4000).toISOString(),
    })
    await page.reload()
    await expect(page.getByText(/^Envoi non confirmé : la Toolbox n’a pas donné de réponse sûre/)).toBeVisible({ timeout: 60_000 })
    await expect(page.getByRole('button', { name: 'Déprogrammer' })).toHaveCount(0)
    // Right after an unknown outcome the Toolbox may still be sending: only « Marquer envoyé » is open.
    await expect(page.getByRole('button', { name: 'Remettre en Validé…' })).toBeDisabled()
    await expect(page.getByText('Brouillon créé dans Infomaniak.')).toHaveCount(0)
    await capture(page, 'contact-unconfirmed', async () => {
      await expect(page.getByRole('button', { name: 'Marquer envoyé…' })).toBeVisible()
    })
    // The dispatcher keeps passing: it never sends again.
    await page.waitForTimeout(3000)
    expect((await fakeDrafts(page)).sent.filter((sent) => sent === draft)).toHaveLength(1)
  } finally {
    await fakeMode(page, {})
  }

  // The person found it in the mailbox's sent items: « Marquer envoyé… », confirmed.
  await page.getByRole('button', { name: 'Marquer envoyé…' }).click()
  const dialog = page.getByRole('dialog', { name: /Marquer le message Contact comme envoyé/ })
  await expect(dialog).toContainText('éléments envoyés de la boîte Infomaniak')
  await page.setViewportSize({ width: 1440, height: 1250 })
  await page.screenshot({ path: `${SCREENSHOTS}/contact-unconfirmed-confirm-dark-1440.png`, animations: 'disabled' })
  await page.setViewportSize({ width: 1440, height: 900 })
  await dialog.getByRole('button', { name: 'Marquer envoyé' }).click()
  await expect(mailTab(page, 'Contact')).toContainText('Envoyé')
  await expect(page.getByText('Envoi confirmé par une personne après vérification dans la boîte Infomaniak.')).toBeVisible()
  expect((await fakeDrafts(page)).sent.filter((sent) => sent === draft)).toHaveLength(1)
})
