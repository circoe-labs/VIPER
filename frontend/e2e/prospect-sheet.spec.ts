import AxeBuilder from '@axe-core/playwright'
import { expect, type Locator, type Page, test } from '@playwright/test'

import { createCompany, post, uniqueSuffix } from './data'
import { E2E_OPENAI_PORT } from './env'
import { SCREENSHOTS, useTheme } from './helpers'
import { signIn } from './session'

// The redesigned prospect sheet end to end (prospect-sheet redesign S7, UI2): a centered floating window, the three KPI
// cards in one order and one height (score prospect, score de proximité, état de la fiche), the header's Mission,
// Contacter and « … » actions, the score evaluation (direct AI call, 2026-11-18: no agent mission), and a look at Profil and Suivi at 1440, 1280 and 800 px. Reads the synthetic dataset
// only; the writes are the mission it creates (bound to the first prospect) and its own run-unique prospects.

test.beforeEach(async ({ page }) => {
  await signIn(page)
})

async function openFirstProspect(page: Page) {
  await page.goto('/prospection')
  await page.getByRole('list', { name: 'Prospects' }).getByRole('link').first().click()
  const editor = page.getByRole('dialog')
  await expect(editor.getByRole('region', { name: 'Résumé du profil' })).toBeVisible()
  return editor
}

test('top of the sheet: fit score, fiche state in words, proximity score, header actions', async ({ page }) => {
  const editor = await openFirstProspect(page)
  const strip = editor.getByRole('region', { name: 'Indicateurs de la fiche' })

  await expect(strip.getByRole('region', { name: 'Score prospect' }).or(strip.getByRole('button', { name: /^Score prospect/ })).first()).toBeVisible()
  const fiche = strip.getByRole('region', { name: 'État de la fiche' })
  await expect(fiche).toContainText(/Incomplète|Exploitable|Fournie|Très fournie|Écarté/)
  await expect(fiche).not.toContainText(/\d+\s*(\/|sur)\s*100/)
  // The proximity score is read from its own endpoint: a figure or an explained empty state, never a spinner for good.
  const proximity = strip.getByRole('region', { name: 'Score de proximité' })
  await expect(proximity).toContainText(/chemin|Aucune relation|Aucun membre/)
  // Not evaluated yet, or already evaluated by an earlier spec of the run (the accessibility spec evaluates one).
  await expect(strip.getByRole('button', { name: /^(Évaluer|Réévaluer le score)$/ })).toBeVisible()

  const header = editor.locator('header').first()
  await expect(header.getByRole('button', { name: 'Mission' })).toBeVisible()
  await expect(header.getByRole('button', { name: 'Contacter' })).toBeVisible()
  await expect(header.getByRole('button', { name: 'Autres actions du prospect' })).toBeVisible()
})

test('centered floating window; exactly three equal KPI cards in order; the « … » menu holds the sheet actions', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  const editor = await openFirstProspect(page)
  const box = await editor.boundingBox()
  if (!box) throw new Error('no dialog box')
  // Centered with margins on every side (not a side drawer), and the page stays dimmed behind it.
  expect(box.x).toBeGreaterThan(40)
  expect(1440 - (box.x + box.width)).toBeGreaterThan(40)
  expect(Math.abs(box.x - (1440 - (box.x + box.width)))).toBeLessThan(3)
  expect(box.y).toBeGreaterThan(8)

  const cards = editor.getByRole('region', { name: 'Indicateurs de la fiche' }).locator(':scope > *')
  await expect(cards).toHaveCount(3)
  const boxes = await cards.evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect()))
  expect(new Set(boxes.map((b) => Math.round(b.height))).size).toBe(1)
  expect(boxes[0]?.height).toBeLessThanOrEqual(190)
  expect(boxes.map((b) => b.left)).toEqual([...boxes.map((b) => b.left)].sort((a, b) => a - b))
  await expect(editor.getByRole('region', { name: 'Score de proximité' })).toBeVisible()
  await expect(editor.getByRole('region', { name: 'État de la fiche' })).toBeVisible()

  await editor.getByRole('button', { name: 'Autres actions du prospect' }).click()
  const menu = page.getByRole('menu', { name: 'Actions du prospect' })
  await expect(menu.getByRole('menuitem')).toHaveText(['Lier à…', 'Mission', 'Contacter', 'Réévaluer le score', 'Graph', 'Société', 'Changer de statut…', 'Archiver…'])
  await page.keyboard.press('Escape')
  await expect(menu).toBeHidden()
  // Esc closed the menu only: the sheet is still there; a second Esc closes it.
  await expect(editor).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(editor).toBeHidden()
})

test('Mission menu: presets, dictation fallback, a prospect-bound mission is created', async ({ page }) => {
  const editor = await openFirstProspect(page)
  await editor.locator('header').first().getByRole('button', { name: 'Mission' }).click()
  const menu = page.getByRole('dialog', { name: 'Mission pour ce prospect' })
  for (const label of ['Complète cette fiche', 'Réanalyse son score', 'Cherche ses relations', 'Autre']) {
    await expect(menu.getByRole('button', { name: new RegExp(label) })).toBeVisible()
  }
  // « Autre »: a written request always works, dictation is offered or explained.
  await menu.getByRole('button', { name: /Autre/ }).click()
  await expect(menu.getByRole('button', { name: /Dicter|Terminer/ })).toBeVisible()
  await menu.getByRole('textbox', { name: 'Que doit faire l’agent ?' }).fill('Trouve son rôle exact dans l’organisation')
  const created = page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/missions')
  await menu.getByRole('button', { name: 'Créer la mission' }).click()
  const response = await created
  expect(response.status()).toBe(201)
  const body = response.request().postDataJSON() as { targets: { kind: string }[]; run_now: boolean }
  expect(body.targets.map((target) => target.kind)).toEqual(['prospect'])
  await expect(menu.getByRole('link', { name: 'Ouvrir la mission' })).toBeVisible()
})

test('Contacter opens the Contact workbench on this prospect', async ({ page }) => {
  const editor = await openFirstProspect(page)
  await editor.locator('header').first().getByRole('button', { name: 'Contacter' }).click()
  await expect(page).toHaveURL(/\/contact\?prospect=/)
})

test('Profil and Suivi stay readable at 1440 and 800 px, with no serious accessibility violation', async ({ page }) => {
  for (const width of [1440, 1280, 800]) {
    await page.setViewportSize({ width, height: 1000 })
    const editor = await openFirstProspect(page)
    await expect(editor.getByRole('region', { name: 'Score de proximité' })).toContainText(/chemin|Aucune relation|Aucun membre/)
    await page.screenshot({ path: `${SCREENSHOTS}/prospect-sheet-profile-${String(width)}.png`, animations: 'disabled' })
    const { violations } = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze()
    expect(violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => v.id)).toEqual([])
    await editor.getByRole('tab', { name: /^Suivi/ }).click()
    await expect(editor.getByRole('region', { name: 'Historique' })).toBeVisible()
    await page.screenshot({ path: `${SCREENSHOTS}/prospect-sheet-tracking-${String(width)}.png`, animations: 'disabled' })
    // No horizontal scroll inside the sheet.
    const overflow = await editor.evaluate((node) => {
      const body = node.querySelector<HTMLElement>('.dialog__body')
      return body ? body.scrollWidth - body.clientWidth : 0
    })
    expect(overflow).toBeLessThanOrEqual(1)
  }
})

// A prospect of this test's own (run-unique, synthetic), opened in the sheet.
async function ownProspect(page: Page, first: string, companyId: string, tag: string, extra: Record<string, unknown> = {}) {
  return post<{ id: string }>(page, '/api/prospects', {
    first_name: first,
    last_name: `Sheet${tag}`,
    company_id: companyId,
    ...extra,
    provenance: { legal_basis_or_collection_context: 'Données synthétiques de test E2E' },
  })
}

async function openOwn(page: Page, id: string) {
  await page.goto(`/prospection?prospect=${id}`)
  const editor = page.getByRole('dialog')
  await expect(editor.getByRole('region', { name: 'Résumé du profil' })).toBeVisible()
  return editor
}

// Context menu (right click / Shift+F10) and the compact Relations card, with no relation then with several.
test('context menu lists the sheet actions; « Lier à… » opens the add form and « Graph » the graph', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  const tag = uniqueSuffix()
  const company = await createCompany(page, { display_name: `Acme Fiche ${tag}` })
  const editor = await openOwn(page, (await ownProspect(page, 'Anne', company.id, tag)).id)
  const card = editor.getByRole('region', { name: 'Relations' })
  await card.scrollIntoViewIfNeeded()
  await expect(card.getByRole('button', { name: 'Lier à', exact: true })).toBeVisible()
  await page.screenshot({ path: `${SCREENSHOTS}/prospect-relations-empty-1440.png`, animations: 'disabled' })

  await editor.getByRole('region', { name: 'Résumé du profil' }).click({ button: 'right', position: { x: 8, y: 8 } })
  const menu = page.getByRole('menu', { name: 'Actions du prospect' })
  await expect(menu.getByRole('menuitem')).toHaveText(['Lier à…', 'Mission', 'Contacter', 'Réévaluer le score', 'Graph', 'Société', 'Changer de statut…', 'Archiver…'])
  await page.screenshot({ path: `${SCREENSHOTS}/prospect-context-menu-1440.png`, animations: 'disabled' })
  await page.keyboard.press('Escape')
  await expect(menu).toBeHidden()

  // Keyboard: Shift+F10 from a field, then Enter on « Lier à… ».
  await editor.getByRole('tab', { name: /^Profil/ }).focus()
  await page.keyboard.press('Shift+F10')
  await expect(menu).toBeVisible()
  await page.keyboard.press('Enter')
  await expect(card.getByRole('combobox', { name: 'Lié à' })).toBeFocused()

  // « Mission » opens the existing popover.
  await editor.getByRole('region', { name: 'Résumé du profil' }).click({ button: 'right', position: { x: 8, y: 8 } })
  await menu.getByRole('menuitem', { name: 'Mission' }).click()
  await expect(page.getByRole('dialog', { name: 'Mission pour ce prospect' })).toBeVisible()
  await page.keyboard.press('Escape')

  await editor.getByRole('region', { name: 'Résumé du profil' }).click({ button: 'right', position: { x: 8, y: 8 } })
  await menu.getByRole('menuitem', { name: 'Graph' }).click()
  await expect(page).toHaveURL(/\/prospection\/graphe\?focus=prospect/)
})

test('Relations card with several links, at 1440 and 800 px', async ({ page }) => {
  await useTheme(page, 'light')
  const tag = uniqueSuffix()
  const company = await createCompany(page, { display_name: `Bravo Fiche ${tag}` })
  const main = await ownProspect(page, 'Yamina', company.id, tag)
  const members = (await (await page.request.get('/api/organizations/members')).json()) as { id: string }[]
  const member = members[0]
  if (member) await post(page, '/api/links', { a: { kind: 'prospect', id: main.id }, b: { kind: 'member', id: member.id }, relation: 'frère', score: 100 })
  const labels = ['amis', 'ancien collègue', 'connaissance']
  for (const [index, label] of labels.entries()) {
    const other = await ownProspect(page, ['Paul', 'Léa', 'Karim'][index] ?? 'Max', company.id, tag)
    await post(page, '/api/links', { a: { kind: 'prospect', id: main.id }, b: { kind: 'prospect', id: other.id }, relation: label, score: 80 - index * 30 })
  }
  for (const width of [1440, 800]) {
    await page.setViewportSize({ width, height: 1000 })
    const editor = await openOwn(page, main.id)
    const card = editor.getByRole('region', { name: 'Relations' })
    await card.scrollIntoViewIfNeeded()
    await expect(card.getByRole('listitem').first()).toBeVisible()
    await card.getByRole('listitem').first().hover()
    await page.screenshot({ path: `${SCREENSHOTS}/prospect-relations-${String(width)}.png`, animations: 'disabled' })
    if (width === 800) {
      await card.getByRole('button', { name: 'Lier à', exact: true }).click()
      await card.getByRole('group', { name: 'Ajouter une relation' }).scrollIntoViewIfNeeded()
      await page.screenshot({ path: `${SCREENSHOTS}/prospect-relations-add-800.png`, animations: 'disabled' })
    }
  }
})

test('light theme: Profil and Suivi at 1440, 1280 and 800 px, no horizontal scroll', async ({ page }) => {
  await useTheme(page, 'light')
  for (const width of [1440, 1280, 800]) {
    await page.setViewportSize({ width, height: 1000 })
    const editor = await openFirstProspect(page)
    await expect(editor.getByRole('region', { name: 'Score de proximité' })).toContainText(/chemin|Aucune relation|Aucun membre/)
    await page.screenshot({ path: `${SCREENSHOTS}/prospect-sheet-profile-light-${String(width)}.png`, animations: 'disabled' })
    await editor.getByRole('tab', { name: /^Suivi/ }).click()
    await expect(editor.getByRole('region', { name: 'Historique' })).toBeVisible()
    await page.screenshot({ path: `${SCREENSHOTS}/prospect-sheet-tracking-light-${String(width)}.png`, animations: 'disabled' })
    const overflow = await editor.evaluate((node) => {
      const body = node.querySelector<HTMLElement>('.dialog__body')
      return body ? body.scrollWidth - body.clientWidth : 0
    })
    expect(overflow).toBeLessThanOrEqual(1)
  }
})

// --- « Évaluer le score »: the AI scores the sheet directly (fake OpenAI, e2e/fake-openai.ts) ------------------------------

const FAKE_OPENAI = `http://127.0.0.1:${String(E2E_OPENAI_PORT)}`

interface FakeRequest {
  instructions?: string
  input?: string
  text?: { format?: { name?: string } }
}

async function scoringRequests(page: Page) {
  const all = (await (await page.request.get(`${FAKE_OPENAI}/requests`)).json()) as FakeRequest[]
  return all.filter((request) => request.text?.format?.name === 'prospect_score')
}

// The three KPI cards keep one height whatever the score card is doing.
async function cardHeights(editor: Locator) {
  const cards = editor.getByRole('region', { name: 'Indicateurs de la fiche' }).locator(':scope > *')
  return cards.evaluateAll((nodes) => nodes.map((node) => Math.round(node.getBoundingClientRect().height)))
}

test('score card: Non évalué, in progress with a counter, success with the new figure, detail with the criteria, at one height', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  await useTheme(page, 'light')
  const tag = uniqueSuffix()
  const company = await createCompany(page, { display_name: `Evaluation ${tag}` })
  const prospect = await ownProspect(page, 'Jeanne', company.id, tag, { exact_job_title: 'Directrice générale' })
  const editor = await openOwn(page, prospect.id)
  const card = editor.getByRole('region', { name: 'Score prospect' })
  const body = card.locator('.score-state')

  await expect(body).toHaveAttribute('data-phase', 'unevaluated')
  await expect(card).toContainText('Non évalué')
  const resting = await cardHeights(editor)
  expect(new Set(resting).size).toBe(1)
  await page.screenshot({ path: `${SCREENSHOTS}/score-eval-1-unevaluated.png`, animations: 'disabled' })

  await card.getByRole('button', { name: 'Évaluer', exact: true }).click()
  await expect(body).toHaveAttribute('data-phase', 'running')
  await expect(card).toContainText('Évaluation en cours')
  await expect(card.locator('.score-state__timer')).toContainText(/\d+ s/)
  expect(await cardHeights(editor)).toEqual(resting)
  await page.screenshot({ path: `${SCREENSHOTS}/score-eval-2-running.png` })

  await expect(body).toHaveAttribute('data-phase', 'success', { timeout: 15_000 })
  await expect(card).toContainText('Score mis à jour')
  await expect(card.locator('.score-ring__value')).toHaveText('85')
  await expect(card.locator('.score-state__detail')).toContainText('Décideur')
  expect(await cardHeights(editor)).toEqual(resting)
  await page.screenshot({ path: `${SCREENSHOTS}/score-eval-3-success.png` })

  // The score is stored: the prospect now answers it, with its provenance.
  const stored = (await (await page.request.get(`/api/prospects/${prospect.id}`)).json()) as {
    score: { total: number; assessment: { model: string; prompt_version: string } | null }
  }
  expect(stored.score.total).toBe(85)
  expect(stored.score.assessment?.model).toBe('fake-e2e-model-snapshot')
  await expect(body).toHaveAttribute('data-phase', 'idle', { timeout: 15_000 })
  await card.getByRole('button', { name: /Voir le détail/ }).click()
  const dialog = page.getByRole('dialog', { name: 'Détail du score' })
  await expect(dialog.getByRole('list', { name: 'Critères de l’évaluation' })).toContainText('Poste décisionnaire')
  await expect(dialog).toContainText('fake-e2e-model-snapshot')
  await page.screenshot({ path: `${SCREENSHOTS}/score-eval-4-detail.png`, animations: 'disabled' })
  await page.keyboard.press('Escape')

  // What reached the model: the whole sheet and the Circoe target; neither the relationships nor the Contact state.
  const sent = (await scoringRequests(page)).at(-1)
  expect(sent?.instructions).toContain('Cible de Circoe')
  expect(sent?.input).toContain(`Sheet${tag}`)
  expect(sent?.input).toContain('Directrice générale')
  expect(sent?.input?.toLowerCase()).not.toMatch(/proximit|séquence|relance/)

  // « Réévaluer » asks again: the same states, in the same place.
  await card.getByRole('button', { name: 'Réévaluer le score' }).click()
  await expect(body).toHaveAttribute('data-phase', 'running')
  await expect(body).toHaveAttribute('data-phase', 'success', { timeout: 15_000 })
})

test('score card failure: a malformed AI answer is one line with the reason, the score is unchanged, Réessayer is offered', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  await useTheme(page, 'light')
  const tag = uniqueSuffix()
  const company = await createCompany(page, { display_name: `Echec ${tag}` })
  const prospect = await ownProspect(page, 'Paul', company.id, tag)
  // The fake answers text that is not the schema when the sheet carries this marker (a note of the prospect).
  await post(page, `/api/prospects/${prospect.id}/notes`, { fact_text: 'FAKE_SCORE_MALFORMED : réponse IA illisible' })
  const editor = await openOwn(page, prospect.id)
  const card = editor.getByRole('region', { name: 'Score prospect' })
  const body = card.locator('.score-state')
  const before = (await (await page.request.get(`/api/prospects/${prospect.id}`)).json()) as { score: unknown }

  await card.getByRole('button', { name: 'Évaluer', exact: true }).click()

  await expect(body).toHaveAttribute('data-phase', 'failed', { timeout: 15_000 })
  await expect(card).toContainText('Échec · score inchangé')
  await expect(card.locator('.score-state__detail')).toContainText('inutilisable')
  await expect(card.getByRole('button', { name: 'Réessayer' })).toBeEnabled()
  await page.screenshot({ path: `${SCREENSHOTS}/score-eval-5-failure.png`, animations: 'disabled' })
  const after = (await (await page.request.get(`/api/prospects/${prospect.id}`)).json()) as { score: unknown }
  expect(after.score).toEqual(before.score)
})

test('Mission menu « Réanalyse son score » and the « … » menu call the evaluation, never a mission', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  const tag = uniqueSuffix()
  const company = await createCompany(page, { display_name: `Menu ${tag}` })
  const prospect = await ownProspect(page, 'Karim', company.id, tag, { exact_job_title: 'Responsable achats' })
  const editor = await openOwn(page, prospect.id)
  const card = editor.getByRole('region', { name: 'Score prospect' })
  const posts: string[] = []
  page.on('request', (request) => {
    if (request.method() === 'POST') posts.push(new URL(request.url()).pathname)
  })

  await editor.locator('header').first().getByRole('button', { name: 'Mission' }).click()
  const menu = page.getByRole('dialog', { name: 'Mission pour ce prospect' })
  await menu.getByRole('button', { name: /Réanalyse son score/ }).click()
  await expect(menu).toContainText('Évaluation en cours')
  await expect(menu).toContainText('Score mis à jour', { timeout: 15_000 })
  await expect(card.locator('.score-ring__value')).toHaveText('50')
  await page.keyboard.press('Escape')

  await editor.getByRole('button', { name: 'Autres actions du prospect' }).click()
  await page.getByRole('menuitem', { name: 'Réévaluer le score' }).click()
  await expect(card.locator('.score-state')).toHaveAttribute('data-phase', 'running')
  await expect(card.locator('.score-state')).toHaveAttribute('data-phase', 'success', { timeout: 15_000 })

  expect(posts.filter((path) => path === `/api/prospects/${prospect.id}/score/evaluate`)).toHaveLength(2)
  expect(posts).not.toContain('/api/missions')
  expect(posts.some((path) => path.includes('/score/reassessment'))).toBe(false)
})

test('Config AI › Scoring prospect: own tab, the two texts, the test on a prospect', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  await useTheme(page, 'light')
  await page.goto('/config-ai/prompt')
  await page.getByRole('navigation', { name: 'Sections de la configuration AI' }).getByRole('link', { name: /Scoring prospect/ }).click()
  await expect(page).toHaveURL(/\/config-ai\/scoring/)
  await expect(page.getByRole('button', { name: 'Configurer : Évaluer un prospect' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Configurer : Cible de Circoe' })).toBeVisible()
  await page.screenshot({ path: `${SCREENSHOTS}/config-ai-scoring-1-tab.png`, animations: 'disabled' })

  await page.getByRole('button', { name: 'Configurer : Cible de Circoe' }).click()
  const dialog = page.getByRole('dialog', { name: 'Cible de Circoe' })
  await expect(dialog.getByRole('textbox', { name: 'Cible de Circoe' })).toContainText('Circoe accompagne les entreprises')
  await page.screenshot({ path: `${SCREENSHOTS}/config-ai-scoring-2-target.png`, animations: 'disabled' })
  await page.keyboard.press('Escape')

  await page.getByRole('button', { name: 'Tester sur un prospect' }).click()
  await expect(page.getByRole('button', { name: /Évaluation… \d+ s/ })).toBeVisible()
  const result = page.locator('.scoring-test__result')
  await expect(result).toContainText('sur 100', { timeout: 15_000 })
  await expect(result).toContainText('fake-e2e-model-snapshot')
  await page.screenshot({ path: `${SCREENSHOTS}/config-ai-scoring-3-test.png`, animations: 'disabled' })
})
