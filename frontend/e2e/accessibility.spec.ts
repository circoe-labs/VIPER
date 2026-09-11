import AxeBuilder from '@axe-core/playwright'
import { expect, type Page, test } from '@playwright/test'

import { syntheticWorkbook, uniqueSuffix } from './data'
import { openDatabase, useTheme } from './helpers'
import { signIn } from './session'

// Automated accessibility smoke (Task 20): axe-core's WCAG 2.1 A/AA rules on every main page and its main dialog, in
// both themes, at a laptop viewport. Serious and critical violations fail the test; the others are reported as
// annotations. Pages read the read-only synthetic dataset; the import review uses its own synthetic workbook.

test.use({ viewport: { width: 1440, height: 900 } })

const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']

async function expectAccessible(page: Page, name: string) {
  const { violations } = await new AxeBuilder({ page }).withTags(WCAG).analyze()
  const blocking = violations.filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
  for (const violation of violations.filter((item) => !blocking.includes(item))) {
    test.info().annotations.push({ type: 'axe', description: `${name}: ${violation.id} (${String(violation.impact)})` })
  }
  const summary = blocking.map((violation) => `${violation.id}: ${violation.nodes.map((node) => node.target.join(' ')).join(' | ')}`)
  expect(summary, `${name}: serious/critical axe violations`).toEqual([])
}

const PAGES: { name: string; open: (page: Page) => Promise<void> }[] = [
  {
    name: 'accueil',
    open: async (page) => {
      await page.goto('/')
      await expect(page.getByRole('heading', { level: 1, name: 'Accueil' })).toBeVisible()
      await expect(page.getByRole('region', { name: 'Dernières modifications' })).toBeVisible()
    },
  },
  {
    name: 'prospection',
    open: async (page) => {
      await page.goto('/prospection')
      await expect(page.getByRole('list', { name: 'Prospects' }).getByRole('link').first()).toBeVisible()
    },
  },
  {
    name: 'éditeur de prospect',
    open: async (page) => {
      await page.goto('/prospection')
      await page.getByRole('list', { name: 'Prospects' }).getByRole('link').first().click()
      await expect(page.getByRole('dialog').getByRole('region', { name: 'Historique' })).toBeVisible()
    },
  },
  {
    name: 'entreprises et éditeur',
    open: async (page) => {
      await page.goto('/prospection/companies')
      await page.getByRole('button', { name: 'Transports Exemple SARL' }).click()
      await expect(page.getByRole('dialog').getByRole('region', { name: 'Prospects associés' })).toBeVisible()
    },
  },
  {
    name: 'revue d’import',
    open: async (page) => {
      const suffix = uniqueSuffix()
      await page.goto('/prospection/import')
      await page.getByLabel('Fichier à importer').setInputFiles({
        name: `a11y-${suffix}.xlsx`,
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        buffer: syntheticWorkbook([
          { company: `Accès Import ${suffix}`, civility: 'M.', last_name: `Lisible${suffix}`, first_name: 'Paul', job: 'Chef de quai fictif', week: 'S37', referent: 'xxx' },
          { company: `Accès Import ${suffix}`, civility: 0, last_name: `Clavier${suffix}`, first_name: 'Léa', email: 'lea.invalide@' },
        ]),
      })
      await page.getByRole('button', { name: 'Confirmer la feuille' }).click()
      await expect(page.getByRole('heading', { name: 'Résumé de l’analyse' })).toBeVisible()
    },
  },
  {
    name: 'base de données',
    open: async (page) => {
      await openDatabase(page, 'companies')
      await expect(page.getByRole('grid', { name: 'Lignes de companies' }).getByRole('gridcell').first()).toBeVisible()
    },
  },
  {
    name: 'console SQL',
    open: async (page) => {
      await openDatabase(page, 'companies')
      await page.getByRole('button', { name: 'Console SQL' }).click()
      const console = page.getByRole('dialog', { name: 'Console SQL' })
      await console.getByRole('textbox').fill('SELECT display_name, siren FROM companies ORDER BY display_name LIMIT 5')
      await console.getByRole('button', { name: /Exécuter/ }).click()
      await expect(console.getByRole('table')).toBeVisible()
    },
  },
  {
    name: 'paramètres',
    open: async (page) => {
      await page.goto('/settings')
      await expect(page.getByRole('table').first()).toBeVisible()
    },
  },
  {
    name: 'exploitation',
    open: async (page) => {
      await page.goto('/exploitation')
      await expect(page.getByRole('heading', { level: 1, name: 'Exploitation' })).toBeVisible()
    },
  },
]

for (const theme of ['dark', 'light'] as const) {
  test(`sign-in page has no serious accessibility violation (${theme})`, async ({ page }) => {
    await useTheme(page, theme)
    await page.goto('/login')
    await expect(page.getByRole('button', { name: 'Se connecter' })).toBeVisible()
    await expectAccessible(page, `connexion (${theme})`)
  })

  for (const { name, open } of PAGES) {
    test(`${name} has no serious accessibility violation (${theme})`, async ({ page }) => {
      await signIn(page)
      await useTheme(page, theme)
      await open(page)
      await expectAccessible(page, `${name} (${theme})`)
    })
  }
}
