import { expect, test } from '@playwright/test'

import { signIn } from './session'

test.beforeEach(async ({ page }) => {
  await signIn(page)
})

test('app shell boots with the five French sections and a connected API', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByText('API : connectée')).toBeVisible()

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
