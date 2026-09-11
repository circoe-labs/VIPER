import { expect, type Page, test } from '@playwright/test'

import { importProspects, uniqueSuffix } from './data'
import { SCREENSHOTS, useTheme } from './helpers'
import { signIn } from './session'

// Home dashboard (Task 16) against the real backend. The test imports its own synthetic people (names carry its
// `uniqueSuffix()`); Home's figures are global, so they are compared with the /api/home answer the page displays —
// never with numbers known in advance (I-81) — and the drill-down is checked on the test's own people through a search.

test.beforeEach(async ({ page }) => {
  await signIn(page)
})

test.use({ viewport: { width: 1440, height: 900 } })

const NUMBER = new Intl.NumberFormat('fr-FR')
const DAY = 24 * 60 * 60 * 1000

interface HomeAnswer {
  counts: Record<string, number>
  companies: number
  stages: Record<string, number>
  next_actions: Record<'appointments' | 'due' | 'responses', { total: number; items: { prospect_id: string }[] }>
  recent_imports: { id: string; filename: string; status: string }[]
}

// Opens Home and returns the /api/home answer it renders.
async function openHome(page: Page): Promise<HomeAnswer> {
  const answer = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/home' && response.ok())
  await page.goto('/')
  const data = (await (await answer).json()) as HomeAnswer
  await expect(page.getByRole('heading', { level: 2, name: 'État de la base' })).toBeVisible()
  return data
}

function kpi(page: Page, group: string, label: string) {
  return page.getByRole('list', { name: group, exact: true }).getByRole('link', { name: new RegExp(`^${label}`) })
}

function isoWeek(day: Date): { year: number; week: number } {
  const date = new Date(Date.UTC(day.getFullYear(), day.getMonth(), day.getDate()))
  date.setUTCDate(date.getUTCDate() + 4 - (date.getUTCDay() || 7))
  const yearStart = Date.UTC(date.getUTCFullYear(), 0, 1)
  return { year: date.getUTCFullYear(), week: Math.ceil(((date.getTime() - yearStart) / DAY + 1) / 7) }
}

test('Home shows the global state it reads, and a card opens its Prospection segment', async ({ page }) => {
  const suffix = uniqueSuffix()
  const tag = `HE2E${suffix}`
  const past = isoWeek(new Date(Date.now() - 10 * DAY))
  const company = `Transports ${tag}`
  const file = `accueil-${suffix}.xlsx`
  await importProspects(
    page,
    file,
    [
      { company, civility: 'M.', first_name: 'Jean', last_name: `Echu${suffix}`, week: `S${String(past.week)}` },
      { company, civility: 'Mme', first_name: 'Claire', last_name: `Relance${suffix}`, relance1: 'x' },
      { company, civility: 'M.', first_name: 'Hugo', last_name: `Rdv${suffix}`, rdv: 'oui' },
    ],
    { [past.week]: past.year },
  )

  const data = await openHome(page)

  for (const name of ['État de la base', 'Activité de contact', 'Prochaines actions', 'Progression du mois']) {
    await expect(page.getByRole('heading', { level: 2, name })).toBeVisible()
  }
  await expect(page.getByRole('heading', { level: 2, name: 'Derniers imports' })).toBeVisible()
  await expect(page.getByRole('heading', { level: 2, name: 'Dernières modifications' })).toBeVisible()

  // Every figure is the one the API answered.
  await expect(kpi(page, 'Base', 'Prospects')).toContainText(NUMBER.format(data.counts.all ?? -1))
  await expect(kpi(page, 'Base', 'Entreprises')).toContainText(NUMBER.format(data.companies))
  for (const [label, segment] of [
    ['Jamais vérifiés', 'never_verified'],
    ['E-mail manquant', 'email_missing'],
  ] as const) {
    await expect(kpi(page, 'Vérification', label)).toContainText(NUMBER.format(data.counts[segment] ?? -1))
  }
  for (const [label, segment] of [
    ['À contacter', 'to_contact'],
    ['Échus', 'due'],
    ['Contactés', 'contacted'],
    ['Sans réponse', 'no_response'],
    ['Réponses', 'responses'],
    ['Rendez-vous', 'appointments'],
  ] as const) {
    await expect(kpi(page, 'Suivi de contact', label)).toContainText(NUMBER.format(data.counts[segment] ?? -1))
  }
  await expect(kpi(page, 'Suivi commercial léger', 'Devis envoyé')).toContainText(
    NUMBER.format(data.stages.quote_sent ?? -1),
  )
  const due = page.getByRole('list', { name: /^Contacts échus/ })
  const dueLinks = due.getByRole('link')
  await expect(dueLinks).toHaveCount(data.next_actions.due.items.length)
  for (const [index, item] of data.next_actions.due.items.entries()) {
    await expect(dueLinks.nth(index)).toHaveAttribute(
      'href',
      `/prospection?segment=due&sort=planned_contact&prospect=${item.prospect_id}`,
    )
  }
  const imports = page.getByRole('list', { name: 'Derniers imports' }).getByRole('listitem')
  await expect(imports).toHaveCount(data.recent_imports.length)
  await expect(imports.first()).toContainText(data.recent_imports[0]?.filename ?? '')
  await expect(page.getByRole('meter', { name: 'Rendez-vous obtenus' })).toHaveAttribute(
    'aria-valuetext',
    /sur un objectif indicatif de 10 /,
  )

  // Drill-down: « Échus » opens Prospection on that segment; the test's own due person is in it.
  await kpi(page, 'Suivi de contact', 'Échus').click()
  await expect(page).toHaveURL(/\/prospection\?segment=due$/)
  const counters = page.getByRole('region', { name: 'Compteurs' })
  await expect(counters.getByRole('button', { name: /^Échus/ })).toHaveAttribute('aria-pressed', 'true')
  await page.getByRole('searchbox', { name: /Rechercher/ }).fill(tag)
  const people = page.getByRole('list', { name: 'Prospects' }).getByRole('listitem')
  await expect(people).toHaveCount(1)
  await expect(people.first()).toContainText(`Echu${suffix}`)

  // Back on Home, « Sans réponse » narrows to the followed-up person only.
  await openHome(page)
  await kpi(page, 'Suivi de contact', 'Sans réponse').click()
  await expect(page).toHaveURL(/segment=no_response/)
  await page.getByRole('searchbox', { name: /Rechercher/ }).fill(tag)
  await expect(people).toHaveCount(1)
  await expect(people.first()).toContainText(`Relance${suffix}`)
})

test('a committed import in the recent activity opens Prospection filtered on it', async ({ page }) => {
  const suffix = uniqueSuffix()
  const company = `Logistique HI${suffix}`
  await importProspects(page, `accueil-import-${suffix}.xlsx`, [
    { company, civility: 'Mme', first_name: 'Léa', last_name: `Import${suffix}` },
  ])

  const data = await openHome(page)

  // Other tests import concurrently: take the newest committed import the page shows, whoever made it.
  const shown = data.recent_imports.find((batch) => batch.status === 'committed')
  expect(shown).toBeDefined()
  await page.getByRole('list', { name: 'Derniers imports' }).getByRole('link', { name: shown?.filename }).first().click()
  await expect(page).toHaveURL(`/prospection?import_batch=${shown?.id ?? ''}`)
  await expect(page.getByRole('combobox', { name: 'Import' })).toHaveValue(shown?.id ?? '')
})

for (const [width, height] of [
  [1440, 900],
  [1280, 800],
] as const) {
  for (const theme of ['dark', 'light'] as const) {
    test(`home screenshots (${theme}, ${String(width)} px)`, async ({ page }) => {
      await page.setViewportSize({ width, height })
      await useTheme(page, theme)
      await openHome(page)
      await page.mouse.move(0, 0)
      await page.screenshot({ path: `${SCREENSHOTS}/home-${theme}-${String(width)}.png`, animations: 'disabled' })
      await page.screenshot({
        path: `${SCREENSHOTS}/home-full-${theme}-${String(width)}.png`,
        animations: 'disabled',
        fullPage: true,
      })
      const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth)
      expect(scrollWidth).toBeLessThanOrEqual(width)
    })
  }
}
