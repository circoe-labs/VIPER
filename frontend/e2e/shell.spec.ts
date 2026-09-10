import { expect, test } from '@playwright/test'

test('app shell boots with the five French sections', async ({ page }) => {
  await page.goto('/')

  const navigation = page.getByRole('navigation', { name: 'Navigation principale' })
  await expect(navigation.getByRole('link')).toHaveText([
    'Accueil',
    'Prospection',
    'Exploitation',
    'Base de données',
    'Paramètres',
  ])
  await expect(page.getByRole('heading', { level: 1, name: 'Accueil' })).toBeVisible()

  await navigation.getByRole('link', { name: 'Prospection' }).click()
  await expect(page).toHaveURL(/\/prospection$/)
  await expect(page.getByRole('heading', { level: 1, name: 'Prospection' })).toBeVisible()
})
