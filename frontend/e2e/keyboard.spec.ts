import { randomBytes } from 'node:crypto'

import { expect, type Locator, type Page, test } from '@playwright/test'

import { importProspects } from './data'
import { E2E_USER, e2ePassword } from './env'

// A keyboard-only working session (Task 20): sign in, reach every section and do the daily work with Tab / Shift+Tab,
// arrows, Enter, Esc and the documented shortcuts — never the mouse — checking at every stop that the focused element
// shows its focus ring. The test's people and company are its own; the synthetic dataset row it edits in the Database
// explorer is only staged, then the change is cancelled (I-81).

test.use({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' })

// Focusing must change how the element — or a frame around it styled with `:focus-within`, such as a field or a
// Prospection card — looks: outline, shadow, border or background, compared with the same nodes once blurred (only
// focus-dependent styles can differ; transitions are off under reduced motion).
async function focusRingShown(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const element = document.activeElement
    if (!(element instanceof HTMLElement) || element === document.body) return false
    const nodes: Element[] = []
    for (let node: Element | null = element; node && nodes.length < 6; node = node.parentElement) nodes.push(node)
    const looks = () =>
      nodes.map((node) => {
        const style = getComputedStyle(node)
        return [style.outlineStyle, style.outlineWidth, style.boxShadow, style.borderColor, style.backgroundColor].join(' ')
      })
    const focused = looks()
    element.blur()
    const blurred = looks()
    element.focus()
    return focused.some((look, index) => look !== blurred[index])
  })
}

// Presses Tab (or Shift+Tab) until `target` has the focus, which must then be visible.
async function tabTo(page: Page, target: Locator, direction: 'forward' | 'backward' = 'forward') {
  await expect(target).toBeVisible()
  for (let presses = 0; presses < 80; presses += 1) {
    if (await target.evaluate((element) => element === document.activeElement)) {
      expect(await focusRingShown(page), 'visible focus ring').toBe(true)
      return
    }
    await page.keyboard.press(direction === 'forward' ? 'Tab' : 'Shift+Tab')
  }
  throw new Error('Not reachable with the keyboard')
}

function navigation(page: Page, name: string) {
  return page.getByRole('navigation', { name: 'Navigation principale' }).getByRole('link', { name })
}

test('a whole working session with the keyboard only', async ({ page }) => {
  test.setTimeout(120_000)
  // Random, like import.spec.ts: the import compares company names by similarity, and run-unique suffixes differ by
  // one digit, so a parallel run's company would change this import's preview between analysis and commit.
  const suffix = randomBytes(3).toString('hex')
  const tag = `KBD${suffix}`
  const company = `Transports ${tag}`

  // Sign-in: the e-mail field has the focus.
  await page.goto('/login')
  await expect(page.getByRole('textbox', { name: 'Adresse e-mail' })).toBeFocused()
  await page.keyboard.type(E2E_USER.email)
  await page.keyboard.press('Tab')
  await page.keyboard.type(e2ePassword())
  await page.keyboard.press('Enter')
  await expect(page.getByRole('heading', { level: 1, name: 'Accueil' })).toBeVisible()
  await importProspects(page, `clavier-${suffix}.xlsx`, [
    { company, civility: 'M.', first_name: 'Jean', last_name: `Clavier${suffix}`, email: `jean@${tag.toLowerCase()}.example` },
    { company, civility: 'Mme', first_name: 'Claire', last_name: `Touche${suffix}`, email: `claire@${tag.toLowerCase()}.example` },
  ])

  // The first stop skips to the content.
  await page.keyboard.press('Tab')
  await expect(page.getByRole('link', { name: 'Aller au contenu' })).toBeFocused()
  expect(await focusRingShown(page)).toBe(true)

  // Prospection: search, open a person, verify, then Ctrl+Entrée saves and opens the next one; Esc closes.
  await tabTo(page, navigation(page, 'Prospection'))
  await page.keyboard.press('Enter')
  await tabTo(page, page.getByRole('searchbox', { name: /Rechercher/ }))
  await page.keyboard.type(tag)
  const people = page.getByRole('list', { name: 'Prospects' })
  await expect(people.getByRole('listitem')).toHaveCount(2)
  await tabTo(page, people.getByRole('link', { name: `Jean Clavier${suffix}` }))
  await page.keyboard.press('Enter')
  const editor = page.getByRole('dialog', { name: `M. Jean Clavier${suffix}` })
  await expect(editor).toHaveAccessibleDescription(/^Prospect 1 sur 2/)
  await tabTo(page, editor.getByRole('button', { name: 'Vérifié aujourd’hui' }))
  await page.keyboard.press('Enter')
  await page.keyboard.press('Control+Enter')
  const next = page.getByRole('dialog', { name: `Mme Claire Touche${suffix}` })
  await expect(next).toHaveAccessibleDescription(/^Prospect 2 sur 2/)
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(people.getByRole('listitem').filter({ hasText: `Clavier${suffix}` })).toContainText('Vérifié le')

  // Entreprises: find the company, edit it, Ctrl+S saves, Esc closes.
  await tabTo(page, page.getByRole('link', { name: 'Entreprises', exact: true }), 'backward')
  await page.keyboard.press('Enter')
  await tabTo(page, page.getByRole('searchbox'))
  await page.keyboard.type(tag)
  const companies = page.getByRole('table', { name: 'Liste des entreprises' })
  await expect(companies.getByRole('row')).toHaveCount(2)
  await tabTo(page, companies.getByRole('button', { name: company }))
  await page.keyboard.press('Enter')
  const drawer = page.getByRole('dialog', { name: company })
  await tabTo(page, drawer.getByRole('textbox', { name: 'Taille' }))
  await page.keyboard.type('50-249 salariés')
  await page.keyboard.press('Control+s')
  await expect(drawer.getByRole('status')).toHaveText('Entreprise enregistrée.')
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)

  // Base de données: header row, rows, context menu, a staged edit cancelled.
  await tabTo(page, navigation(page, 'Base de données'), 'backward')
  await page.keyboard.press('Enter')
  await tabTo(page, page.getByRole('navigation', { name: 'Tables' }).getByRole('link', { name: /^companies/ }))
  await page.keyboard.press('Enter')
  const grid = page.getByRole('grid', { name: 'Lignes de companies' })
  await tabTo(page, grid.getByRole('button', { name: /^id,/ }))
  await page.keyboard.press('ArrowRight')
  await expect(grid.getByRole('button', { name: /^display_name,/ })).toBeFocused()
  await page.keyboard.press('ArrowDown')
  const cell = grid.locator('[data-cell="0:1"]')
  await expect(cell).toBeFocused()
  expect(await focusRingShown(page)).toBe(true)
  await page.keyboard.press('Shift+F10')
  const menu = page.getByRole('menu', { name: 'Actions sur display_name' })
  await expect(menu.getByRole('menuitem').first()).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(cell).toBeFocused()
  await page.keyboard.press('F2')
  await page.keyboard.type(' modifié')
  await page.keyboard.press('Enter')
  const pending = page.getByRole('region', { name: 'Modifications en attente' })
  await expect(pending).toContainText('1')
  await tabTo(page, pending.getByRole('button', { name: 'Annuler' }))
  await page.keyboard.press('Enter')
  await expect(pending).toHaveCount(0)

  // Paramètres: sections are links; the list's first action is reachable.
  await tabTo(page, navigation(page, 'Paramètres'), 'backward')
  await page.keyboard.press('Enter')
  const sections = page.getByRole('navigation', { name: 'Sections des paramètres' })
  await tabTo(page, sections.getByRole('link', { name: /^Référents internes/ }))
  await page.keyboard.press('Enter')
  await expect(sections.getByRole('link', { name: /^Référents internes/ })).toHaveAttribute('aria-current', 'page')
  await tabTo(page, page.getByRole('searchbox'))
})

