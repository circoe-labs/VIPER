import { expect, type Page, test } from '@playwright/test'

import { createCompany, csrfToken, post, uniqueSuffix } from './data'
import { useTheme } from './helpers'
import { signIn } from './session'

// This spec writes only synthetic data in the dedicated *_e2e database.
test('Contacts: real statistics, independent chart dates, filters, compact details and responsive layout', async ({ page }) => {
  test.setTimeout(90_000)
  await signIn(page)
  const suffix = uniqueSuffix()
  const tag = `CRM${suffix}`
  const company = await createCompany(page, { display_name: `Transports ${tag}` })
  const other = await createCompany(page, { display_name: `Logistique ${tag}` })
  const cohort = await post<{ id: string }>(page, '/api/settings/cohorts', { code: 'S901', starts_on: '2026-09-28' })
  async function person(first: string, companyId: string, sends: number) {
    const prospect = await post<{ id: string }>(page, '/api/prospects', {
      first_name: first, last_name: tag, company_id: companyId, exact_job_title: 'Directeur transport',
      emails: [{ address: `${first.toLowerCase()}.${suffix}@crm-e2e.example`, is_primary: true }],
      provenance: { legal_basis_or_collection_context: 'Données synthétiques de test E2E' },
    })
    const response = await page.request.put(`/api/prospects/${prospect.id}/cohort`, { data: { cohort_id: cohort.id }, headers: { 'X-CSRF-Token': await csrfToken(page) } })
    expect(response.ok(), await response.text()).toBe(true)
    for (let rank = 0; rank < sends; rank++) {
      await post(page, `/api/prospects/${prospect.id}/messages/mark-sent`, { rank, sent_at: `2026-10-0${String(rank + 1)}T09:00:00+02:00` })
    }
    return prospect.id
  }
  const claire = await person('Claire', company.id, 2)
  await person('Jean', other.id, 1)
  await person('SansEnvoi', other.id, 0)
  await page.goto(`/contact?q=${tag}`)
  await expect(page.getByRole('heading', { level: 1, name: 'Contacts' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Répartition des 2 contacts' })).toBeVisible()
  const section = page.getByRole('button', { name: /^Prospects contactés/ })
  await expect(section).toHaveAttribute('aria-expanded', 'false')
  await expect(page.getByRole('list', { name: 'Prospects contactés' })).toHaveCount(0)
  const dates = page.locator('.contacts-chart__date input')
  await expect(dates).toHaveCount(5)
  for (let index = 0; index < 5; index++) await expect(dates.nth(index)).toHaveValue('')
  await dates.nth(0).fill('2026-10-05')
  await dates.nth(0).blur()
  await expect.poll(async () => (await (await page.request.get(`/api/contact/overview?q=${tag}`)).json() as { bars: { send_date: string | null }[] }).bars[0]?.send_date).toBe('2026-10-05')
  await dates.nth(1).fill('2026-10-12')
  await dates.nth(1).blur()
  await expect.poll(async () => (await (await page.request.get(`/api/contact/overview?q=${tag}`)).json() as { bars: { send_date: string | null }[] }).bars[1]?.send_date).toBe('2026-10-12')
  await page.reload()
  await expect(dates.nth(0)).toHaveValue('2026-10-05')
  await expect(dates.nth(1)).toHaveValue('2026-10-12')
  await expect(dates.nth(2)).toHaveValue('')
  await page.getByRole('button', { name: 'Effacer la date — Contact', exact: true }).click()
  await page.reload()
  await expect(dates.nth(0)).toHaveValue('')
  await expect(dates.nth(1)).toHaveValue('2026-10-12')
  await section.click()
  const list = page.getByRole('list', { name: 'Prospects contactés' })
  await expect(list.getByRole('listitem')).toHaveCount(2)
  await page.getByRole('button', { name: `Détails de Claire ${tag}` }).click()
  const details = page.getByRole('region', { name: `Fiche de Claire ${tag}` })
  await expect(details).toContainText('Contact initial')
  await expect(details).toContainText('Relance R1')
  await expect(details.getByRole('link', { name: 'Modifier la fiche' })).toHaveAttribute('href', `/prospection?prospect=${claire}`)
  await page.getByRole('button', { name: `Détails de Claire ${tag}` }).click()
  await expect(details).toHaveCount(0)
  await page.getByRole('button', { name: `Actions de Claire ${tag}` }).click()
  await expect(page.getByRole('menuitem', { name: 'Ouvrir le suivi' })).toBeVisible()
  await page.keyboard.press('Escape')
  await page.getByRole('combobox', { name: 'Entreprise', exact: true }).selectOption(company.id)
  await expect(list.getByRole('listitem')).toHaveCount(1)
  await expect(page.getByRole('heading', { name: 'Répartition de 1 contact' })).toBeVisible()
  await page.getByRole('combobox', { name: 'Statut', exact: true }).selectOption('level:r1_sent')
  await expect(list.getByRole('listitem')).toHaveCount(1)
  await page.getByRole('button', { name: 'Réinitialiser' }).click()
  await expect(page.getByRole('combobox', { name: 'Entreprise', exact: true })).toHaveValue('')
  await page.getByRole('searchbox').fill(tag)
  await expect(list.getByRole('listitem')).toHaveCount(2)

  await checkLayout(page, tag)
  await expect(page.getByRole('link', { name: 'Ajouter un contact' })).toHaveAttribute('href', '/prospection?prospect=new')
})

async function checkLayout(page: Page, tag: string) {
  for (const theme of ['dark', 'light'] as const) {
    await useTheme(page, theme)
    for (const width of [1440, 1280, 390]) {
      await page.setViewportSize({ width, height: 1000 })
      await page.goto(`/contact?q=${tag}`)
      await expect(page.locator('.contacts-chart__date input')).toHaveCount(5)
      await expect(page.getByRole('button', { name: /^Prospects contactés/ })).toHaveAttribute('aria-expanded', 'false')
      const columns = page.locator('.contacts-chart__column')
      const dates = page.locator('.contacts-chart__date')
      for (let index = 0; index < 5; index++) {
        const bar = await columns.nth(index).boundingBox()
        const date = await dates.nth(index).boundingBox()
        expect(bar).not.toBeNull()
        expect(date).not.toBeNull()
        if (bar && date) expect(Math.abs(bar.x + bar.width / 2 - date.x - date.width / 2)).toBeLessThan(1)
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0)
      await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); window.scrollTo(0, 0) })
      await page.screenshot({ path: `test-results/contacts-crm-${theme}-${String(width)}-closed.png`, fullPage: true })
      await page.getByRole('button', { name: /^Prospects contactés/ }).click()
      await expect(page.getByRole('list', { name: 'Prospects contactés' }).getByRole('listitem')).toHaveCount(2)
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0)
      await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); window.scrollTo(0, 0) })
      await page.screenshot({ path: `test-results/contacts-crm-${theme}-${String(width)}-open.png`, fullPage: true })
      if (width === 390) {
        await page.getByRole('button', { name: `Détails de Claire ${tag}` }).click()
        await expect(page.getByRole('region', { name: `Fiche de Claire ${tag}` })).toContainText('Relance R1')
        expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0)
        await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); window.scrollTo(0, 0) })
        await page.screenshot({ path: `test-results/contacts-crm-${theme}-mobile-details.png`, fullPage: true })
      }
    }
  }
}
