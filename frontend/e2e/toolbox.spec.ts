import { rmSync } from 'node:fs'

import { expect, type Page, test } from '@playwright/test'

import { createContactProspect, uniqueSuffix } from './data'
import { E2E_TOOLBOX_PORT, E2E_TOOLBOX_STORE } from './env'
import { SCREENSHOTS, useTheme } from './helpers'
import { signIn } from './session'

// CIRCOE Toolbox (Contact port S6) against the fake Toolbox started by playwright.config.ts (e2e/fake-toolbox.ts): the
// real OAuth redirect flow in the browser, the Infomaniak draft created at validation, deleted after a cancellation by
// the API's worker, a failure said and retried, then « Oublier la connexion ». The connection is one per server: the
// steps run in order, in one worker.

test.describe.configure({ mode: 'serial' })
test.use({ viewport: { width: 1440, height: 900 } })

const FAKE = `http://127.0.0.1:${String(E2E_TOOLBOX_PORT)}`

interface FakeDrafts {
  drafts: { id: string; subject: string }[]
  deleted: string[]
}

async function fakeDrafts(page: Page): Promise<FakeDrafts> {
  return (await (await page.request.get(`${FAKE}/drafts`)).json()) as FakeDrafts
}

async function fakeMode(page: Page, mode: { toolErrorText?: string }) {
  expect((await page.request.post(`${FAKE}/mode`, { data: mode })).ok()).toBe(true)
}

function toolboxCard(page: Page) {
  return page.getByRole('region', { name: 'CIRCOE Toolbox' })
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

async function captureSettings(page: Page, name: string) {
  for (const theme of ['dark', 'light'] as const) {
    await useTheme(page, theme)
    await page.reload()
    await expect(toolboxCard(page)).toBeVisible()
    await page.screenshot({ path: `${SCREENSHOTS}/settings-connections-${name}-${theme}-1440.png`, animations: 'disabled' })
  }
  await useTheme(page, 'dark')
  await page.reload()
}

async function writeAndValidate(page: Page, step: string, subject: string) {
  await mailTab(page, step).click()
  const from = page.getByRole('textbox', { name: 'De' })
  if ((await from.inputValue()) === '') await from.fill('prospection@exemple.example')
  await page.getByRole('textbox', { name: 'Objet' }).fill(subject)
  await page.getByRole('textbox', { name: 'Corps' }).fill('Bonjour,\n\nMessage synthétique de test.\n\nCordialement')
  await page.getByRole('button', { name: 'Créer le brouillon' }).click()
  await expect(mailTab(page, step)).toContainText('Brouillon')
  await page.getByRole('button', { name: 'Valider…' }).click()
  await confirm(page, new RegExp(`Valider le message ${step}`), 'Valider le message')
  await expect(mailTab(page, step)).toContainText('Validé')
}

test.beforeAll(() => {
  rmSync(E2E_TOOLBOX_STORE, { force: true })
})

test.beforeEach(async ({ page }) => {
  await signIn(page)
})

test('connect through the Toolbox, then the state and the limits are said', async ({ page }) => {
  await page.goto('/settings/connections')
  await expect(toolboxCard(page)).toContainText('Non connectée')
  await expect(toolboxCard(page)).toContainText('boîte Infomaniak par défaut du compte connecté')
  await captureSettings(page, 'disconnected')

  await page.getByRole('button', { name: 'Connecter la Toolbox' }).click()

  // The fake Toolbox accepts at once and sends the browser back to this page, which finishes the connection.
  await expect(page.getByRole('status').filter({ hasText: /CIRCOE Toolbox connectée jusqu’au/ })).toHaveCount(1)
  await expect(page).toHaveURL(/\/settings\/connections$/)
  await expect(toolboxCard(page)).toContainText('Connectée')
  await expect(toolboxCard(page)).toContainText('Pilote E2E')
  await expect(toolboxCard(page)).toContainText(FAKE)
  await captureSettings(page, 'connected')
})

test('validating creates the Infomaniak draft; cancelling deletes it; a failure is said and retried', async ({ page }) => {
  const suffix = uniqueSuffix()
  const tag = `TBX${suffix}`
  const { id } = await createContactProspect(page, tag, {
    civility: 'mr',
    first_name: 'Hugo',
    last_name: `Toolbox${suffix}`,
    email: `hugo.${suffix}@toolbox-e2e.example`,
  })
  await page.goto(`/contact?prospect=${id}`)
  await expect(page.getByText('Envoi réel depuis la boîte Infomaniak par défaut du compte connecté')).toBeVisible()

  const subject = `Transport ${tag}`
  await writeAndValidate(page, 'Contact', subject)
  await expect(page.getByText('Brouillon créé dans Infomaniak.')).toBeVisible()
  const created = (await fakeDrafts(page)).drafts.find((draft) => draft.subject === subject)
  expect(created, 'the fake Toolbox holds the draft').toBeDefined()
  for (const theme of ['dark', 'light'] as const) {
    await useTheme(page, theme)
    await page.reload()
    await expect(page.getByText('Brouillon créé dans Infomaniak.')).toBeVisible()
    await page.setViewportSize({ width: 1440, height: 1250 })
    await page.screenshot({ path: `${SCREENSHOTS}/contact-remote-draft-${theme}-1440.png`, animations: 'disabled' })
    await page.setViewportSize({ width: 1440, height: 900 })
  }
  await useTheme(page, 'dark')
  await page.reload()

  // Cancelling queues the draft; the API's worker deletes it from Infomaniak (the fake) within seconds.
  await page.getByRole('button', { name: 'Annuler le message…' }).click()
  await confirm(page, /Annuler le message Contact/, 'Annuler le message')
  await expect(mailTab(page, 'Contact')).toContainText('Annulé')
  await expect
    .poll(async () => (await fakeDrafts(page)).deleted.includes(created?.id ?? ''), { timeout: 15_000 })
    .toBe(true)

  // A Toolbox failure: the validation stands, the failure is said, « Réessayer » creates the draft.
  await fakeMode(page, { toolErrorText: 'L\'API Infomaniak Mail a répondu 503' })
  try {
    await writeAndValidate(page, 'R1', `Relance ${tag}`)
    await expect(page.getByText('Brouillon Infomaniak non créé : la Toolbox ne répond pas.')).toBeVisible()
    await page.setViewportSize({ width: 1440, height: 1250 })
    await page.screenshot({ path: `${SCREENSHOTS}/contact-remote-draft-failed-dark-1440.png`, animations: 'disabled' })
    await page.setViewportSize({ width: 1440, height: 900 })
  } finally {
    await fakeMode(page, {})
  }
  await page.getByRole('button', { name: 'Réessayer' }).click()
  await expect(page.getByText('Brouillon créé dans Infomaniak.')).toBeVisible()
  expect((await fakeDrafts(page)).drafts.some((draft) => draft.subject === `Relance ${tag}`)).toBe(true)
})

test('forgetting the connection, after a confirmation', async ({ page }) => {
  await page.goto('/settings/connections')
  await expect(toolboxCard(page)).toContainText('Connectée')
  await page.getByRole('button', { name: 'Oublier la connexion…' }).click()
  await confirm(page, /Oublier la connexion à la Toolbox/, 'Oublier la connexion')

  await expect(page.getByRole('status').filter({ hasText: /Connexion oubliée/ })).toHaveCount(1)
  await expect(toolboxCard(page)).toContainText('Non connectée')
  await expect(page.getByRole('button', { name: 'Connecter la Toolbox' })).toBeVisible()
})

// Design review of the states the E2E server cannot reach by itself (its Toolbox is enabled and configured): the
// status answer is replaced in the browser only, nothing is written.
test('design: the disabled, not configured and expired cards', async ({ page }) => {
  const base = {
    enabled: true,
    configured: true,
    connected: false,
    missing: [],
    toolbox_origin: FAKE,
    connected_at: null,
    connected_by: null,
    expires_at: null,
    account_label: null,
    last_error: null,
    cleanups: { pending: 0, failing: 0 },
  }
  const states = {
    disabled: { ...base, enabled: false, configured: false, state: 'disabled', toolbox_origin: null },
    'not-configured': { ...base, configured: false, state: 'not_configured', missing: ['VIPER_TOOLBOX_MCP_URL'] },
    expired: {
      ...base,
      state: 'expired',
      connected_at: '2026-09-01T07:00:00+00:00',
      connected_by: 'Pilote E2E',
      expires_at: '2026-10-01T07:00:00+00:00',
      last_error: { code: 'toolbox_auth_expired', at: '2026-10-01T07:05:00+00:00' },
      cleanups: { pending: 2, failing: 1 },
    },
  }
  let current: unknown = null
  await page.route(/\/api\/settings\/toolbox$/, (route) => route.fulfill({ json: current }))
  for (const [name, status] of Object.entries(states)) {
    current = status
    for (const theme of ['dark', 'light'] as const) {
      await useTheme(page, theme)
      await page.goto('/settings/connections')
      await expect(toolboxCard(page)).toBeVisible()
      await page.screenshot({ path: `${SCREENSHOTS}/settings-connections-${name}-${theme}-1440.png`, animations: 'disabled' })
    }
  }
  await useTheme(page, 'dark')
})

