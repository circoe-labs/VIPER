import { mkdirSync } from 'node:fs'
import path from 'node:path'

import { expect, type Page, test } from '@playwright/test'

import { createContactProspect, csrfToken, uniqueSuffix } from './data'
import { E2E_OPENAI_PORT, E2E_TOOLBOX_PORT } from './env'
import { blockRealToolbox, REAL_TOOLBOX_HOST, SCREENSHOTS, useTheme } from './helpers'
import { signIn } from './session'

// Paramètres › Connexions (Contact port S8): everything typed in the browser and applied at once, without a restart —
// the OpenAI key (write-only), the model and the API address, then « Se connecter à CIRCOE Toolbox » with its advanced
// address — against the local fakes only (Contact port P6: never OpenAI, never the real Toolbox). These settings are
// the whole server's: this project runs last and alone, and puts every value back to its environment default.

test.describe.configure({ mode: 'serial' })
test.use({ viewport: { width: 1440, height: 900 } })

const FAKE_OPENAI = `http://127.0.0.1:${String(E2E_OPENAI_PORT)}`
const FAKE_TOOLBOX = `http://127.0.0.1:${String(E2E_TOOLBOX_PORT)}`
const REFUSED_KEY = 'sk-e2e-refusee-cle-0001'
const BROWSER_KEY = 'sk-e2e-navigateur-cle-4242'
// Design review copies, outside the repository (the orchestrator's scratchpad), besides test-results/screenshots.
const REVIEW_DIR = process.env.VIPER_E2E_REVIEW_DIR

interface IntegrationsBody {
  version: number
  fields: Record<string, { value: unknown; source: string }>
  openai_api_key: { set: boolean; last4: string | null; source: string | null }
}

async function integrations(page: Page): Promise<IntegrationsBody> {
  const response = await page.request.get('/api/settings/integrations')
  expect(response.ok()).toBe(true)
  return (await response.json()) as IntegrationsBody
}

// Every setting back to the server's environment default (`null`), the key set here removed.
async function resetAll(page: Page) {
  const current = await integrations(page)
  const data = { version: current.version, openai_api_key: null, ...Object.fromEntries(Object.keys(current.fields).map((name) => [name, null])) }
  const response = await page.request.put('/api/settings/integrations', { data, headers: { 'X-CSRF-Token': await csrfToken(page) } })
  expect(response.ok(), await response.text()).toBe(true)
}

async function fakeKeys(page: Page): Promise<{ drafted: string[]; checked: string[] }> {
  return (await (await page.request.get(`${FAKE_OPENAI}/keys`)).json()) as { drafted: string[]; checked: string[] }
}

function card(page: Page, name: string) {
  return page.getByRole('region', { name: 'Connexions' }).getByRole('region', { name })
}

async function confirm(page: Page, title: RegExp, button: string) {
  const dialog = page.getByRole('dialog', { name: title })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: button }).click()
  await expect(dialog).toBeHidden()
}

async function replaceKey(page: Page, key: string) {
  const openai = card(page, 'Rédaction IA (OpenAI)')
  await openai.getByRole('button', { name: 'Remplacer' }).click()
  await openai.getByLabel('Clé d’API OpenAI').fill(key)
}

async function capture(page: Page, name: string) {
  for (const theme of ['dark', 'light'] as const) {
    await useTheme(page, theme)
    await page.reload()
    await expect(card(page, 'CIRCOE Toolbox')).toBeVisible()
    const file = `connections-${name}-${theme}-1440.png`
    await page.screenshot({ path: `${SCREENSHOTS}/${file}`, fullPage: true, animations: 'disabled' })
    if (REVIEW_DIR) {
      mkdirSync(REVIEW_DIR, { recursive: true })
      await page.screenshot({ path: path.join(REVIEW_DIR, file), fullPage: true, animations: 'disabled' })
    }
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    expect(overflow, 'no horizontal overflow at 1440 px').toBe(0)
  }
  await useTheme(page, 'dark')
  await page.reload()
}

test.beforeEach(async ({ page, context }) => {
  await blockRealToolbox(context)
  await signIn(page)
})

test.beforeAll(async ({ browser }) => {
  const page = await browser.newPage()
  await blockRealToolbox(page.context())
  await signIn(page)
  await resetAll(page)
  await page.close()
})

test.afterAll(async ({ browser }) => {
  // Leave the server as found: no Toolbox connection, every value back to the environment's.
  const page = await browser.newPage()
  await blockRealToolbox(page.context())
  await signIn(page)
  await page.goto('/settings/connections')
  const disconnect = page.getByRole('button', { name: 'Se déconnecter…' })
  if (await disconnect.isVisible()) {
    await disconnect.click()
    await confirm(page, /Se déconnecter de CIRCOE Toolbox/, 'Se déconnecter')
  }
  await resetAll(page)
  await page.close()
})

test('an OpenAI key typed in the browser drafts at once, without a restart', async ({ page }) => {
  const suffix = uniqueSuffix()
  const tag = `CNX${suffix}`
  const { id } = await createContactProspect(page, tag, {
    civility: 'ms',
    first_name: 'Nina',
    last_name: `Reglages${suffix}`,
    email: `nina.${suffix}@connexions-e2e.example`,
  })

  // 1. A key the service refuses: « Tester la clé » says so, and so does the drafting — the saved key is the one used.
  await page.goto('/settings/connections')
  const openai = card(page, 'Rédaction IA (OpenAI)')
  await expect(openai).toContainText('Clé fournie par la configuration du serveur.')
  await replaceKey(page, REFUSED_KEY)
  await openai.getByRole('button', { name: 'Enregistrer' }).click()
  await expect(openai.getByText(/Clé et réglages OpenAI enregistrés/)).toBeVisible()
  await expect(openai.getByLabel('Clé d’API OpenAI')).toHaveAttribute('placeholder', '•••• 0001 (enregistrée)')
  await openai.getByRole('button', { name: 'Tester la clé' }).click()
  await expect(openai.getByText('Test échoué : la clé a été refusée par OpenAI.')).toBeVisible()

  await page.goto(`/contact?prospect=${id}`)
  await page.getByRole('button', { name: 'Générer avec l’IA' }).click()
  await expect(page.getByText(/La clé OpenAI a été refusée/)).toBeVisible()

  // 2. Another key, a model and the API address typed here: accepted, and the next drafting uses them.
  await page.goto('/settings/connections')
  await replaceKey(page, BROWSER_KEY)
  await openai.getByRole('textbox', { name: 'Modèle' }).fill('modele-navigateur')
  await openai.getByText('Paramètres avancés', { exact: true }).click()
  await openai.getByRole('textbox', { name: 'Adresse de l’API' }).fill(`${FAKE_OPENAI}/v1`)
  await openai.getByRole('button', { name: 'Enregistrer' }).click()
  await expect(openai.getByText(/Clé et réglages OpenAI enregistrés/)).toBeVisible()
  await expect(openai.getByRole('textbox', { name: 'Modèle' })).toHaveAccessibleDescription(/Défini ici par Pilote E2E/)
  await openai.getByRole('button', { name: 'Tester la clé' }).click()
  await expect(openai.getByText(/Clé acceptée : le modèle « modele-navigateur » est disponible/)).toBeVisible()

  // The key never comes back to the browser.
  const body = await integrations(page)
  expect(JSON.stringify(body)).not.toContain(BROWSER_KEY)
  expect(body.openai_api_key).toMatchObject({ set: true, last4: '4242', source: 'ui' })
  expect(await page.content()).not.toContain(BROWSER_KEY)
  await capture(page, 'openai')

  await page.goto(`/contact?prospect=${id}`)
  await page.getByRole('button', { name: 'Générer avec l’IA' }).click()
  await expect(page.getByText('Rédigé par l’IA — à relire avant de valider.')).toBeVisible()
  await expect(page.getByText(/Modèle modele-navigateur-snapshot/)).toBeVisible()
  const keys = await fakeKeys(page)
  expect(keys.drafted.at(-1)).toBe('4242')
  expect(keys.checked.at(-1)).toBe('4242')
})

test('« Se connecter à CIRCOE Toolbox » from the settings, with the advanced address typed here', async ({ page }) => {
  // Start without any server address (the E2E server's own points at the fake): the page says what is missing.
  await page.goto('/settings/connections')
  const toolbox = card(page, 'CIRCOE Toolbox')
  await expect(toolbox.getByRole('button', { name: 'Se connecter à CIRCOE Toolbox' })).toBeVisible()

  // The server address, typed in « Paramètres avancés »: a refused one is said under the field; then the local fake
  // (written with a final slash, so it differs from the E2E server's own value and is saved here) — never the real
  // Toolbox.
  await toolbox.getByText('Paramètres avancés', { exact: true }).click()
  const server = toolbox.getByRole('textbox', { name: 'Adresse du serveur CIRCOE Toolbox' })
  await expect(server).not.toHaveValue(new RegExp(REAL_TOOLBOX_HOST))
  await server.fill('http://toolbox.exemple.example/mcp')
  await toolbox.getByRole('button', { name: 'Enregistrer les paramètres avancés' }).click()
  await expect(toolbox.getByText('Adresse https attendue (http seulement sur localhost).')).toBeVisible()
  await expect(server).toHaveAttribute('aria-invalid', 'true')
  await toolbox.screenshot({ path: `${SCREENSHOTS}/connections-toolbox-refused-dark-1440.png`, animations: 'disabled' })
  if (REVIEW_DIR) await toolbox.screenshot({ path: path.join(REVIEW_DIR, 'connections-toolbox-refused-dark-1440.png'), animations: 'disabled' })
  await server.fill(`${FAKE_TOOLBOX}/mcp/`)
  await toolbox.getByRole('button', { name: 'Enregistrer les paramètres avancés' }).click()
  await expect(toolbox.getByText('Paramètres de la Toolbox enregistrés.')).toBeVisible()
  const saved = await integrations(page)
  expect(saved.fields.toolbox_mcp_url).toMatchObject({ value: `${FAKE_TOOLBOX}/mcp/`, source: 'ui' })

  // The scheduled sending, off until chosen here.
  const dispatch = card(page, 'Envoi programmé')
  await dispatch.getByRole('combobox', { name: 'Fréquence de vérification' }).selectOption({ label: 'Toutes les 10 secondes' })
  await dispatch.getByRole('button', { name: 'Enregistrer' }).click()
  await expect(dispatch.getByText(/Envoi programmé enregistré/)).toBeVisible()

  // One click: the browser goes to the (fake) Toolbox, which comes back to this page at once.
  const authorize = page.waitForRequest((request) => request.url().includes('/authorize'))
  await toolbox.getByRole('button', { name: 'Se connecter à CIRCOE Toolbox' }).click()
  const visited = new URL((await authorize).url())
  expect(visited.origin).toBe(FAKE_TOOLBOX)
  expect(visited.hostname).not.toBe(REAL_TOOLBOX_HOST)
  expect(visited.searchParams.get('redirect_uri')).toMatch(/\/settings\/connections$/)
  await expect(page.getByRole('status').filter({ hasText: /CIRCOE Toolbox connectée jusqu’au/ })).toHaveCount(1)
  await expect(toolbox).toContainText('Connectée')
  await expect(dispatch).toContainText('Actif')
  await expect(dispatch).toContainText('vérification toutes les 10 s')
  await capture(page, 'toolbox-connected')

  // « Se déconnecter… »: token forgotten, integration off, the scheduled sending stopped.
  await toolbox.getByRole('button', { name: 'Se déconnecter…' }).click()
  await confirm(page, /Se déconnecter de CIRCOE Toolbox/, 'Se déconnecter')
  await expect(page.getByRole('status').filter({ hasText: /Déconnecté de CIRCOE Toolbox/ })).toHaveCount(1)
  await expect(toolbox).toContainText('Désactivée')
  await expect(dispatch).toContainText('En attente')
  await capture(page, 'toolbox-disabled')
})
