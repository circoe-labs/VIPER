import { expect, test } from '@playwright/test'

import { E2E_USER, e2ePassword } from './env'
import { submitLoginForm } from './session'

// Review screenshots land in the git-ignored test-results/ folder.
const SCREENSHOTS = 'test-results/screenshots'

test.use({ viewport: { width: 1440, height: 900 } })

test('a wrong password is refused with one generic message', async ({ page }) => {
  await page.goto('/login')

  await submitLoginForm(page, E2E_USER.email, 'pas-le-bon-mot-de-passe')

  await expect(page.getByRole('alert')).toHaveText('Adresse e-mail ou mot de passe incorrect.')
  await expect(page).toHaveURL(/\/login$/)
  await expect(page.getByLabel('Mot de passe')).toBeFocused()
  await expect(page.getByLabel('Mot de passe')).toHaveValue('')
})

test('sign in opens the shell, a reload keeps the session, sign out returns to the login page', async ({ page }) => {
  await page.goto('/')
  await expect(page).toHaveURL(/\/login$/)
  await expect(page.getByRole('img', { name: 'VIPER' })).toHaveAttribute('src', /viper-lockup-white/)
  await page.screenshot({ path: `${SCREENSHOTS}/login-dark.png` })

  await submitLoginForm(page, E2E_USER.email, e2ePassword())

  await expect(page.getByRole('heading', { level: 1, name: 'Accueil' })).toBeVisible()
  await expect(page.getByText(E2E_USER.displayName)).toBeVisible()
  await expect(page.getByText('API : connectée')).toBeVisible()
  await page.screenshot({ path: `${SCREENSHOTS}/shell-signed-in.png` })

  await page.reload()
  await expect(page.getByRole('heading', { level: 1, name: 'Accueil' })).toBeVisible()
  await expect(page.getByText(E2E_USER.displayName)).toBeVisible()

  await page.getByRole('button', { name: 'Se déconnecter' }).click()
  await expect(page).toHaveURL(/\/login$/)
  await expect(page.getByRole('status')).toHaveText('Vous êtes déconnecté.')
  // Revoked server-side, not just forgotten by the browser.
  expect((await page.request.get('/api/auth/session')).status()).toBe(401)
  await page.goto('/prospection')
  await expect(page).toHaveURL(/\/login$/)
})

test('a deep link is restored after signing in', async ({ page }) => {
  await page.goto('/database')
  await expect(page).toHaveURL(/\/login$/)

  await submitLoginForm(page, E2E_USER.email, e2ePassword())

  await expect(page).toHaveURL(/\/database$/)
  await expect(page.getByRole('heading', { level: 1, name: 'Base de données' })).toBeVisible()
})

test('the session cookie is HttpOnly, Secure, SameSite=Strict and scoped to /api', async ({ page, context }) => {
  await page.goto('/login')
  await submitLoginForm(page, E2E_USER.email, e2ePassword())
  await expect(page.getByRole('heading', { level: 1, name: 'Accueil' })).toBeVisible()

  expect(await context.cookies()).toEqual([
    expect.objectContaining({ name: 'viper_session', httpOnly: true, secure: true, sameSite: 'Strict', path: '/api' }),
  ])
  expect(await page.evaluate(() => document.cookie)).toBe('')
})

test('the login page uses the dark-on-light lockup in the light theme', async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem('viper.theme', 'light')
  })
  await page.goto('/login')

  await expect(page.getByRole('img', { name: 'VIPER' })).toHaveAttribute('src', /viper-lockup-black/)
  await page.screenshot({ path: `${SCREENSHOTS}/login-light.png` })
})
