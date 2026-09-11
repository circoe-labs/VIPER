import { expect, type Page, test } from '@playwright/test'

import { createCompany, importProspects, syntheticSiren, syntheticSiret, uniqueSuffix } from './data'
import { SCREENSHOTS, useTheme } from './helpers'
import { signIn } from './session'

// Global search (Task 17) against the real backend. Each test creates its own company (API), establishments and
// prospects (import API) whose names carry a word and its `uniqueSuffix()`; searching both words finds only these
// rows, so every assertion is on the test's own data whatever other tests write meanwhile (I-81).

test.use({ viewport: { width: 1440, height: 900 } })

test.beforeEach(async ({ page }) => {
  await signIn(page)
})

interface Seeded {
  // Two words only this test's rows carry, e.g. `Recherche 01003`.
  tag: string
  company: string
  siren: string
  mobile: string
}

async function seed(page: Page, word: string): Promise<Seeded> {
  const suffix = uniqueSuffix()
  const tag = `${word} ${suffix}`
  const siren = syntheticSiren(suffix)
  const company = `Fret ${tag}`
  await createCompany(page, {
    display_name: company,
    legal_name: `Société ${tag} SAS`,
    siren,
    email_domain: `${word.toLowerCase()}-${suffix}.example.com`,
    establishments: [
      { name: `Entrepôt ${tag}`, siret: syntheticSiret(siren, 1), city: 'Évreux', is_primary: true },
      { name: `Quai ${tag}`, siret: syntheticSiret(siren, 2), city: 'Lyon', kind: 'quai', is_primary: false },
    ],
  })
  const mobile = `07990${suffix}`
  const domain = `${word.toLowerCase()}-${suffix}.example.com`
  await importProspects(page, `recherche-${suffix}.xlsx`, [
    { company, civility: 'Mme', first_name: 'Solène', last_name: tag, job: 'Responsable transport', email: `solene@${domain}`, mobile },
    { company, civility: 'M.', first_name: 'Bastien', last_name: tag, job: 'Chef de quai', email: `bastien@${domain}` },
    { company, civility: 'Mme', first_name: 'Inès', last_name: tag, job: 'Directrice logistique' },
  ])
  return { tag, company, siren, mobile }
}

function field(page: Page) {
  return page.getByRole('combobox', { name: 'Recherche globale' })
}

function results(page: Page) {
  return page.getByRole('listbox', { name: 'Résultats de la recherche' })
}

function group(page: Page, name: string) {
  return results(page).getByRole('group', { name: new RegExp(`^${name}`) })
}

interface SearchAnswer {
  groups: { type: string; items: { id: string; label: string }[] }[]
}

// Types `text` in the search and waits for its (debounced) answer.
async function search(page: Page, text: string): Promise<SearchAnswer> {
  const answer = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/search' && new URL(response.url()).searchParams.get('q') === text,
  )
  await field(page).fill(text)
  const response = await answer
  expect(response.ok()).toBe(true)
  const body = (await response.json()) as SearchAnswer
  await expect(results(page)).toBeVisible()
  return body
}

test('Ctrl+K finds the test’s prospects, company and establishments; each opens where it belongs', async ({ page }) => {
  const seeded = await seed(page, 'Recherche')
  await page.goto('/exploitation')
  await expect(page.getByRole('heading', { level: 1, name: 'Exploitation' })).toBeVisible()

  await page.keyboard.press('Control+k')
  await expect(field(page)).toBeFocused()
  const answer = await search(page, seeded.tag)

  const people = group(page, 'Prospects').getByRole('option')
  await expect(people).toHaveCount(3)
  await expect(people.nth(0)).toContainText(`Bastien ${seeded.tag}`)
  await expect(people.nth(0)).toContainText(`Chef de quai`)
  await expect(people.nth(2)).toContainText(`Solène ${seeded.tag}`)
  const companies = group(page, 'Entreprises').getByRole('option')
  await expect(companies).toHaveCount(1)
  await expect(companies.first()).toContainText(seeded.company)
  await expect(companies.first()).toContainText(`SIREN ${seeded.siren.replace(/(\d{3})(?=\d)/g, '$1 ')}`)
  await expect(companies.first()).toContainText('3 prospects')
  const sites = group(page, 'Établissements').getByRole('option')
  await expect(sites).toHaveCount(2)
  await expect(sites.nth(0)).toContainText(`Entrepôt ${seeded.tag}`)
  await expect(sites.nth(0)).toContainText('Principal')

  // Keyboard: the fourth option is the company; Enter opens it in the Company editor.
  await expect(people.nth(0)).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowDown')
  await expect(companies.first()).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('Enter')
  const editor = page.getByRole('dialog', { name: seeded.company })
  await expect(editor).toBeVisible()
  await expect(editor.getByRole('textbox', { name: 'SIREN' })).toHaveValue(/\d/)
  await page.keyboard.press('Escape')
  await expect(editor).toBeHidden()
  await expect(field(page)).toBeFocused()

  // A prospect opens `/prospection?prospect=<id>` (the Prospect editor contract).
  const solene = answer.groups.find((found) => found.type === 'prospect')?.items.find((item) => item.label.startsWith('Solène'))
  expect(solene).toBeDefined()
  const visited: string[] = []
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) visited.push(frame.url())
  })
  await search(page, seeded.tag)
  await people.nth(2).click()
  await expect.poll(() => visited.some((url) => url.endsWith(`/prospection?prospect=${solene?.id ?? ''}`))).toBe(true)
  await expect(field(page)).toHaveValue('')
})

test('a phone number, a SIREN and a SIRET find the test’s rows; Shift+Enter opens the explorer row', async ({ page }) => {
  const seeded = await seed(page, 'Numéros')
  await page.goto('/exploitation')
  await field(page).click()

  const byPhone = await search(page, seeded.mobile.replace(/(\d{2})(?=\d)/g, '$1 '))
  expect(byPhone.groups.map((found) => found.type)).toEqual(['prospect'])
  await expect(group(page, 'Prospects').getByRole('option')).toHaveCount(1)
  await expect(group(page, 'Prospects').getByRole('option')).toContainText(`Solène ${seeded.tag}`)

  await search(page, seeded.siren)
  await expect(group(page, 'Entreprises').getByRole('option')).toHaveCount(1)
  await expect(group(page, 'Établissements').getByRole('option')).toHaveCount(2)
  // The SIREN is the whole company identifier: the company group comes first.
  await expect(results(page).getByRole('group').first()).toHaveAttribute('aria-label', 'Entreprises')

  await search(page, syntheticSiret(seeded.siren, 2))
  const site = group(page, 'Établissements').getByRole('option')
  await expect(site).toHaveCount(1)
  await expect(site).toContainText(`Quai ${seeded.tag}`)
  await field(page).press('Shift+Enter')
  await expect(page).toHaveURL(/\/database\/establishments\?/)
  await expect(page.getByRole('grid', { name: /establishments/ })).toContainText(`Quai ${seeded.tag}`)
})

test('« / » opens the search from the page; Escape closes it, then clears it', async ({ page }) => {
  const seeded = await seed(page, 'Clavier')
  await page.goto('/exploitation')
  await expect(page.getByRole('heading', { level: 1, name: 'Exploitation' })).toBeVisible()

  await page.keyboard.press('/')
  await expect(field(page)).toBeFocused()
  await expect(field(page)).toHaveValue('')
  await search(page, seeded.tag)
  await page.keyboard.press('Escape')
  await expect(results(page)).toBeHidden()
  await expect(field(page)).toHaveValue(seeded.tag)
  await page.keyboard.press('Escape')
  await expect(field(page)).toHaveValue('')

  await field(page).fill('z')
  await expect(page.getByText('Saisissez au moins 2 caractères.')).toBeVisible()
  await field(page).fill(`${seeded.tag} introuvable`)
  await expect(page.getByText(`Aucun résultat pour « ${seeded.tag} introuvable ».`)).toBeVisible()
})

for (const theme of ['dark', 'light'] as const) {
  test(`global search screenshots (${theme})`, async ({ page }) => {
    const seeded = await seed(page, 'Vitrine')
    await useTheme(page, theme)
    await page.goto('/')
    await expect(page.getByRole('heading', { level: 1, name: 'Accueil' })).toBeVisible()

    await page.keyboard.press('Control+k')
    await search(page, seeded.tag)
    await page.keyboard.press('ArrowDown')
    await page.screenshot({ path: `${SCREENSHOTS}/global-search-${theme}.png`, animations: 'disabled' })

    // Badges from the read-only synthetic dataset: its « Sophie Test » people include an opposed one.
    await search(page, 'sophie test')
    await expect(group(page, 'Prospects').getByText('Ne pas contacter').first()).toBeVisible()
    await page.screenshot({ path: `${SCREENSHOTS}/global-search-badges-${theme}.png`, animations: 'disabled' })

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    expect(overflow).toBe(0)
  })
}
