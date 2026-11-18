import AxeBuilder from '@axe-core/playwright'
import { expect, type Page, test } from '@playwright/test'

import { createCompany, post, uniqueSuffix } from './data'
import { SCREENSHOTS, useTheme } from './helpers'
import { signIn } from './session'

// The redesigned prospect sheet end to end (prospect-sheet redesign S7): the three indicators at the top (commercial
// fit score, fiche state as a word, separate proximity score), the header's Mission menu and Contacter action, the
// reassessment entry point, and a look at Profil and Suivi at a wide and a narrow width. Reads the synthetic dataset
// only; the one write is the mission it creates, bound to the first prospect.

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
  await expect(strip.getByRole('button', { name: 'Évaluer', exact: true })).toBeVisible()

  const header = editor.locator('header').first()
  await expect(header.getByRole('button', { name: 'Mission' })).toBeVisible()
  await expect(header.getByRole('button', { name: 'Contacter' })).toBeVisible()
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
  for (const width of [1440, 800]) {
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
async function ownProspect(page: Page, first: string, companyId: string, tag: string) {
  return post<{ id: string }>(page, '/api/prospects', {
    first_name: first,
    last_name: `Sheet${tag}`,
    company_id: companyId,
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
  await expect(menu.getByRole('menuitem')).toHaveText(['Lier à…', 'Mission', 'Contacter', 'Réévaluer le score', 'Graph', 'Société'])
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
  await expect(page).toHaveURL(/\/prospection\/graphe\?prospect=/)
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

test('light theme: Profil and Suivi at 1440 px', async ({ page }) => {
  await useTheme(page, 'light')
  await page.setViewportSize({ width: 1440, height: 1000 })
  const editor = await openFirstProspect(page)
  await expect(editor.getByRole('region', { name: 'Score de proximité' })).toContainText(/chemin|Aucune relation|Aucun membre/)
  await page.screenshot({ path: `${SCREENSHOTS}/prospect-sheet-profile-light-1440.png`, animations: 'disabled' })
  await editor.getByRole('tab', { name: /^Suivi/ }).click()
  await expect(editor.getByRole('region', { name: 'Historique' })).toBeVisible()
  await page.screenshot({ path: `${SCREENSHOTS}/prospect-sheet-tracking-light-1440.png`, animations: 'disabled' })
})
