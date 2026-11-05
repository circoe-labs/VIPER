import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'
import { createCompany, post, uniqueSuffix } from './data'
import { signIn } from './session'
import { SCREENSHOTS, useTheme } from './helpers'

async function createValidatedPerson(page: import('@playwright/test').Page, companyId: string, firstName: string, lastName: string) {
  return post(page, '/api/prospects', {
    first_name: firstName, last_name: lastName, company_id: companyId,
    employment_verification: { action: 'verified_now' },
    emails: [{ address: `${lastName.toLowerCase()}.${firstName.toLowerCase()}@example.test`, is_primary: true, verified_now: true }],
    phones: [], provenance: { legal_basis_or_collection_context: 'Test synthétique E2E' },
  })
}

async function expandCompanies(page: import('@playwright/test').Page) {
  for (const toggle of await page.getByRole('button', { name: /^Afficher les contacts de / }).all()) {
    await toggle.click()
  }
}

async function openValidatedList(page: import('@playwright/test').Page) {
  const toggle = page.getByRole('button', { name: 'Afficher la liste' })
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await expect(page.getByRole('table', { name: 'Prospects' })).toBeHidden()
  await toggle.click()
}

test.beforeEach(async ({ page }) => {
  await signIn(page)
})
test.use({ viewport: { width: 1440, height: 1000 } })

test('dashboard uses real totals and an accessible responsive table', async ({ page }) => {
  await useTheme(page, 'dark')
  await page.goto('/contacts-joignables')
  await expect(page.getByRole('heading', { name: 'Prospects validés', exact: true })).toBeVisible()
  await openValidatedList(page)
  await expect(page.getByRole('table', { name: 'Prospects' })).toBeVisible()
  const response = await page.request.get('/api/prospection/dashboard?validated_only=true')
  expect(response.ok()).toBe(true)
  const data = (await response.json()) as { total: number; sends: Record<string, number> }
  await expect(page.locator('.stat-total .stat-value')).toHaveText(
    new Intl.NumberFormat('fr-FR').format(data.total),
  )
  await expect(page.getByRole('heading', { name: 'Suivi des envois' })).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'Prestations propos\u00e9es' })).toHaveCount(0)
  await expect(page.locator('.prospects-dashboard')).not.toContainText(/R3|R4|S37|S39/)
  await page.screenshot({ path: `${SCREENSHOTS}/prospects-dashboard-dark.png`, fullPage: false })
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.screenshot({ path: `${SCREENSHOTS}/prospects-dashboard-laptop.png`, fullPage: false })
  const dimensions = await page.evaluate(() => ({
    viewport: innerWidth, page: document.documentElement.scrollWidth,
    panels: [...document.querySelectorAll('.prospects-dashboard > *, .prospects-list-filters > *')].map((node) => ({ className: node.className, right: node.getBoundingClientRect().right })),
  }))
  expect(dimensions.page, JSON.stringify(dimensions)).toBeLessThanOrEqual(dimensions.viewport)
  await page.screenshot({ path: `${SCREENSHOTS}/prospects-dashboard-laptop.png`, fullPage: false })
  await page.getByRole('button', { name: 'Masquer la liste' }).click()
  await expect(page.getByRole('table', { name: 'Prospects' })).toBeHidden()
  await page.getByRole('button', { name: 'Afficher la liste' }).click()
  await expect(page.getByRole('table', { name: 'Prospects' })).toBeVisible()
})

test('several interests persist and appear on all company contacts', async ({
  page,
}) => {
  const tag = `Services${uniqueSuffix()}`
  const company = await createCompany(page, { display_name: tag })
  for (const first_name of ['Anne', 'Bruno']) {
    await createValidatedPerson(page, company.id, first_name, tag)
  }
  await page.goto(`/contacts-joignables?q=${tag}`)
  await openValidatedList(page)
  const table = page.getByRole('table', { name: 'Prospects' })
  await expect(table.locator('tbody tr[data-prospect-id]')).toHaveCount(2)
  await expandCompanies(page)
  await table
    .getByRole('button', { name: /^IGUARD/ })
    .first()
    .click()
  const dialog = page.getByRole('dialog', { name: `Prestations · ${tag}` })
  await dialog.getByRole('button', { name: /IGUARD/ }).click()
  await expect(dialog.getByRole('button', { name: /IGUARD/ })).toHaveAttribute('aria-pressed', 'true')
  await dialog.getByRole('button', { name: /IADVICE/ }).click()
  await expect(dialog.getByRole('button', { name: /IADVICE/ })).toHaveAttribute('aria-pressed', 'true')
  await dialog.getByRole('button', { name: 'Terminer' }).click()
  await page.reload()
  await openValidatedList(page)
  await expect(table.locator('tbody tr[data-prospect-id]')).toHaveCount(2)
  await expandCompanies(page)
  await expect(table.getByRole('button', { name: /^IGUARD.*besoin identifié/ })).toHaveCount(2)
  await expect(table.getByRole('button', { name: /^IADVICE.*besoin identifié/ })).toHaveCount(2)
  const saved = await page.request.get(`/api/companies/${company.id}/services`)
  expect(((await saved.json()) as { services: string[] }).services).toEqual(['iadvice', 'iguard'])
})

test('server pagination, search and existing editor retain URL context', async ({ page }) => {
  test.slow() // Creates 52 owned validated records before exercising the UI.
  const tag = `Pagination${uniqueSuffix()}`
  const company = await createCompany(page, { display_name: tag })
  for (let start = 0; start < 52; start += 5) {
    await Promise.all(Array.from({ length: Math.min(5, 52 - start) }, (_, index) => createValidatedPerson(page, company.id, 'Contact', `${tag}${String(start + index).padStart(2, '0')}`)))
  }
  await page.goto(`/contacts-joignables?q=${tag}`)
  await openValidatedList(page)
  const table = page.getByRole('table', { name: 'Prospects' })
  await expect(table.locator('tbody tr[data-prospect-id]')).toHaveCount(50)
  await page.getByRole('button', { name: 'Page 2', exact: true }).click()
  await expect(table.locator('tbody tr[data-prospect-id]')).toHaveCount(2)
  await expect(page.getByText('Affichage de 51 à 52 sur 52 prospects')).toBeVisible()
  await expandCompanies(page)
  await table
    .getByRole('link', { name: /^Contact/ })
    .first()
    .click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toBeHidden()
  expect(new URL(page.url()).searchParams.get('q')).toBe(tag)
  expect(new URL(page.url()).searchParams.get('page')).toBe('2')
  expect(new URL(page.url()).searchParams.get('review')).toBeNull()
  await page.reload()
  await openValidatedList(page)
  await expect(table.locator('tbody tr[data-prospect-id]')).toHaveCount(2)
})

test('accessible controls and table pass axe', async ({ page }) => {
  const tag = `Accessible${uniqueSuffix()}`
  const company = await createCompany(page, { display_name: tag })
  await createValidatedPerson(page, company.id, 'Anne', tag)
  await page.goto(`/contacts-joignables?q=${tag}`)
  await openValidatedList(page)
  await expect(page.getByRole('table').locator('tbody tr[data-prospect-id]')).toHaveCount(1)
  const audit = await new AxeBuilder({ page }).analyze()
  expect(audit.violations).toEqual([])
})
