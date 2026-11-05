import { expect, type Page, test } from '@playwright/test'

import type { HomeDashboard } from '../src/api/home'
import { createCompany, csrfToken, post, uniqueSuffix } from './data'
import { useTheme } from './helpers'
import { signIn } from './session'

// Only the dedicated *_e2e database receives these synthetic records.
test('Home: six real counters, working destinations and responsive cards', async ({ page }) => {
  test.setTimeout(120_000)
  await signIn(page)
  const tag = `Dashboard${uniqueSuffix()}`
  const company = await createCompany(page, { display_name: tag })
  const first = await post<{ id: string }>(page, '/api/prospects', {
    first_name: 'Alice', last_name: tag, company_id: company.id,
    tracking: { status: 'appointment_obtained' },
    emails: [{ address: `${tag.toLowerCase()}@dashboard-e2e.example`, is_primary: true }],
    provenance: { legal_basis_or_collection_context: 'Données synthétiques de test E2E' },
  })
  await post(page, '/api/prospects', {
    first_name: 'Bob', last_name: tag, company_id: company.id,
    provenance: { legal_basis_or_collection_context: 'Données synthétiques de test E2E' },
  })
  const cohort = await post<{ id: string }>(page, '/api/settings/cohorts', { code: 'S902', starts_on: '2026-09-28' })
  const assigned = await page.request.put(`/api/prospects/${first.id}/cohort`, {
    data: { cohort_id: cohort.id }, headers: { 'X-CSRF-Token': await csrfToken(page) },
  })
  expect(assigned.ok(), await assigned.text()).toBe(true)
  for (const rank of [0, 1]) {
    await post(page, `/api/prospects/${first.id}/messages/mark-sent`, { rank, sent_at: `2026-10-0${String(rank + 1)}T09:00:00+02:00` })
  }
  const data = await dashboard(page)
  const owned = await page.request.get(`/api/contact/overview?q=${tag}`)
  expect((await owned.json() as { total: number }).total).toBe(1)

  for (const theme of ['dark', 'light'] as const) {
    await page.goto('/')
    await useTheme(page, theme)
    for (const width of [1440, 1024, 390]) {
      await page.setViewportSize({ width, height: 1000 })
      // Other specs may add people concurrently: compare with the exact response this visit renders.
      const answer = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/home/dashboard' && response.ok())
      await page.goto('/')
      const shown = await (await answer).json() as HomeDashboard
      await expect(page.getByRole('heading', { name: 'Accueil', exact: true })).toBeVisible()
      await expect(page.getByRole('combobox', { name: 'Recherche globale' })).toBeVisible()
      const totals = page.getByRole('list', { name: 'Chiffres clés' })
      const growth = page.getByRole('list', { name: 'Nouveautés cette semaine' })
      await expect(totals.getByRole('link')).toHaveCount(4)
      await expect(growth.getByRole('link')).toHaveCount(2)
      for (const [index, value] of [shown.prospects, shown.companies, shown.contacted, shown.appointments].entries()) {
        await expect(totals.locator('.home-stat__value').nth(index)).toHaveText(new Intl.NumberFormat('fr-FR').format(value))
      }
      const cards = totals.getByRole('link')
      const boxes = await Promise.all([0, 1, 2, 3].map((index) => cards.nth(index).boundingBox()))
      expect(boxes.every(Boolean)).toBe(true)
      if (width === 1440) expect(new Set(boxes.map((box) => box?.y)).size).toBe(1)
      if (width === 1024) expect(new Set(boxes.map((box) => box?.y)).size).toBe(2)
      if (width === 390) expect(new Set(boxes.map((box) => box?.y)).size).toBe(4)
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0)
      if (width === 390) {
        const search = page.getByRole('combobox', { name: 'Recherche globale' })
        await search.fill(tag)
        await expect(page.getByRole('listbox')).toBeVisible()
        expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0)
        await search.fill('')
        await search.press('Escape')
      }
      expect(await page.locator('.home-stat__value').evaluateAll((values) => values.every((value) => value.scrollWidth <= value.clientWidth))).toBe(true)
      await expect(page.getByRole('main').getByRole('table')).toHaveCount(0)
      await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); window.scrollTo(0, 0) })
      await page.screenshot({ path: `test-results/home-dashboard-${theme}-${String(width)}.png`, fullPage: true })
    }
  }

  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.goto('/')
  await page.getByRole('list', { name: 'Chiffres clés' }).getByRole('link', { name: /Prospects$/ }).click()
  await expect(page.getByRole('list', { name: 'Prospects', exact: true })).toBeVisible()
  await page.goto('/')
  await page.getByRole('list', { name: 'Chiffres clés' }).getByRole('link', { name: /Entreprises$/ }).click()
  await expect(page.getByRole('heading', { name: 'Entreprises', exact: true })).toBeVisible()
  await page.goto('/')
  await page.getByRole('list', { name: 'Chiffres clés' }).getByRole('link', { name: /Contactés$/ }).click()
  await expect(page.getByRole('button', { name: /^Prospects contactés/ })).toHaveAttribute('aria-expanded', 'true')
  await expect(page.getByRole('list', { name: 'Prospects contactés' })).toBeVisible()
  await page.goto('/')
  await page.getByRole('list', { name: 'Chiffres clés' }).getByRole('link', { name: /RDV pris$/ }).click()
  await expect(page).toHaveURL(/segment=appointments/)
  await expect(page.getByRole('list', { name: 'Prospects', exact: true })).toBeVisible()

  for (const [kind, expected] of [['entreprise', 1], ['prospect', 2]] as const) {
    await page.goto('/')
    await page.getByRole('list', { name: 'Nouveautés cette semaine' }).getByRole('link', { name: new RegExp(kind) }).click()
    await expect(page.getByRole('group', { name: 'Filtre de date de création' })).toBeVisible()
    const params = new URL(page.url()).searchParams
    expect(params.get('created_from')).toBe(data.week_start)
    expect(params.get('created_to')).toBe(data.week_end)
    params.set('q', tag)
    const result = await page.request.get(`/api/${kind === 'entreprise' ? 'companies' : 'prospection/prospects'}?${params.toString()}`)
    expect((await result.json() as { total: number }).total).toBe(expected)
    await page.getByRole('button', { name: 'Retirer le filtre de création' }).click()
    await expect(page.getByRole('group', { name: 'Filtre de date de création' })).toHaveCount(0)
    expect(new URL(page.url()).searchParams.has('created_from')).toBe(false)
  }
  await page.goto('/')
  await page.getByRole('link', { name: 'Importer Excel', exact: true }).click()
  await expect(page).toHaveURL(/\/prospection\/import/)
  await page.goto('/')
  await page.getByRole('link', { name: 'Ouvrir la prospection', exact: true }).click()
  await expect(page).toHaveURL(/\/prospection$/)
})

async function dashboard(page: Page): Promise<HomeDashboard> {
  const result = await page.request.get('/api/home/dashboard')
  expect(result.ok(), await result.text()).toBe(true)
  return await result.json() as HomeDashboard
}
