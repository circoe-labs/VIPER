import { expect, type Page } from '@playwright/test'

import { E2E_USER, e2ePassword } from './env'

// Signs the page's browser context in through the API (page.request shares the context's cookies). For specs that
// are not about sign-in itself; auth.spec.ts drives the real form.
export async function signIn(page: Page) {
  const response = await page.request.post('/api/auth/login', {
    data: { email: E2E_USER.email, password: e2ePassword() },
  })
  expect(response.status()).toBe(200)
}

export async function submitLoginForm(page: Page, email: string, password: string) {
  await page.getByRole('textbox', { name: 'Adresse e-mail' }).fill(email)
  await page.getByLabel('Mot de passe').fill(password)
  await page.getByRole('button', { name: 'Se connecter' }).click()
}
