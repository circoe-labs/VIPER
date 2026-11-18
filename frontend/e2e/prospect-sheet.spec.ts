import AxeBuilder from '@axe-core/playwright'
import { expect, type Page, test } from '@playwright/test'

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

  await expect(strip.getByRole('button', { name: /^Score prospect/ })).toBeVisible()
  const fiche = strip.getByRole('region', { name: 'État de la fiche' })
  await expect(fiche).toContainText(/Incomplète|Exploitable|Fournie|Très fournie|Écarté/)
  await expect(fiche).not.toContainText(/\d+\s*(\/|sur)\s*100/)
  // The proximity score is read from its own endpoint: a figure or an explained empty state, never a spinner for good.
  const proximity = strip.getByRole('region', { name: 'Score de proximité' })
  await expect(proximity).toContainText(/chemin|Aucune relation|Aucun membre/)
  await expect(strip.getByRole('button', { name: 'Réévaluer le score', exact: true })).toBeVisible()

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
