import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'
import { createCompany, post, uniqueSuffix } from './data'
import { useTheme } from './helpers'
import { signIn } from './session'

test('Prospection separates employment validation from email checks and works on mobile', async ({ page }) => {
  await signIn(page)
  await useTheme(page, 'dark')
  const tag = `Validation${uniqueSuffix()}`
  const company = await createCompany(page, { display_name: tag })
  await post(page, '/api/prospects', {
    first_name: 'Alice', last_name: tag, company_id: company.id,
    employment_verification: { action: 'verified_now' },
    emails: [], phones: [], provenance: { legal_basis_or_collection_context: 'Test synthétique' },
  })
  await page.goto('/prospection')
  const response = await page.request.get('/api/prospection/overview')
  const overview = await response.json() as { total: number; employment_validated: number; employment_pending: number; ignored: number }
  expect(overview.total).toBe(overview.employment_validated + overview.employment_pending + overview.ignored)
  const validation = page.getByRole('region', { name: 'Validation des prospects' })
  await expect(validation.getByRole('button', { name: `Emploi validé : ${new Intl.NumberFormat('fr-FR').format(overview.employment_validated)}`, exact: true })).toBeVisible()
  await expect(page.getByRole('list', { name: 'Prospects', exact: true })).toBeHidden()
  await expect(page.getByText('Vérification de la base', { exact: true })).toHaveCount(0)
  await validation.getByRole('button', { name: /^Emploi validé/ }).click()
  await expect(page).toHaveURL(/validated_only=true/)
  await page.getByRole('searchbox', { name: 'Rechercher : nom, entreprise, e-mail, téléphone' }).fill(tag)
  await expect(page.getByRole('list', { name: 'Prospects', exact: true }).getByRole('listitem')).toHaveCount(1)
  await expect(page.getByRole('list', { name: 'Prospects', exact: true }).getByRole('link', { name: `Alice ${tag}` })).toBeVisible()
  await page.reload()
  await expect(page.getByRole('list', { name: 'Prospects', exact: true }).getByRole('listitem')).toHaveCount(1)
  await page.goto('/prospection')
  await page.setViewportSize({ width: 1440, height: 1100 })
  await expect(validation.getByRole('button', { name: /^Emploi validé : \d/ })).toBeVisible()
  await expect(page.getByRole('link', { name: /^Entreprises \d/ })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Suivi commercial', exact: true })).toBeVisible()
  await page.screenshot({ path: 'test-results/prospection-clarity-desktop.png', fullPage: true })
  expect((await new AxeBuilder({ page }).include('.prospection').analyze()).violations).toEqual([])
  await page.setViewportSize({ width: 390, height: 844 })
  await page.screenshot({ path: 'test-results/prospection-clarity-mobile.png', fullPage: true })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await validation.getByRole('button', { name: /^Validation non enregistrée/ }).click()
  await expect(page).toHaveURL(/segment=never_verified&review=to_verify/)
  const filtered = await page.request.get('/api/prospection/prospects?segment=never_verified&review=to_verify')
  expect((await filtered.json() as { total: number }).total).toBe(overview.employment_pending)
})
