import { expect, type Page, test } from '@playwright/test'

// Rows a test owns (decision I-81). Specs run fully parallel, in any order, on one shared E2E database: the synthetic
// dataset loaded by global setup is read-only for them, and every row a test writes is its own, named with
// `uniqueSuffix()`, so neither a concurrent test nor a repeated run of the same test ever sees or collides with it.

let created = 0

// Unique within the run (global setup rebuilds the database for every run): the worker index, never reused within a
// run, and a per-worker counter. Fixed width, so no suffix is a prefix of another; digits only, so it also fits in a
// synthetic SIREN.
export function uniqueSuffix(): string {
  created += 1
  return `${String(test.info().workerIndex).padStart(2, '0')}${String(created).padStart(3, '0')}`
}

// Appends the Luhn check digit that SIREN and SIRET numbers carry.
function withCheckDigit(body: string): string {
  let sum = 0
  for (let index = 0; index < body.length; index += 1) {
    // From the right, every other digit is doubled, starting next to the check digit.
    const value = Number(body[body.length - 1 - index]) * (index % 2 === 0 ? 2 : 1)
    sum += value > 9 ? value - 9 : value
  }
  return `${body}${String((10 - (sum % 10)) % 10)}`
}

// A SIREN with a valid check digit, 999 followed by the suffix, as used by no other test of the run.
export function syntheticSiren(suffix: string): string {
  return withCheckDigit(`999${suffix}`)
}

// SIRET number `nic` (1-9999) of that SIREN, with its check digit.
export function syntheticSiret(siren: string, nic: number): string {
  return withCheckDigit(`${siren}${String(nic).padStart(4, '0')}`)
}

// Writes through the real, audited API as the signed-in page (its session cookie and CSRF token).
async function post<T>(page: Page, path: string, data: object): Promise<T> {
  const session = await page.request.get('/api/auth/session')
  expect(session.ok()).toBe(true)
  const { csrf_token: csrfToken } = (await session.json()) as { csrf_token: string }
  const response = await page.request.post(path, { data, headers: { 'X-CSRF-Token': csrfToken } })
  expect(response.ok(), await response.text()).toBe(true)
  return (await response.json()) as T
}

export interface CompanySeed {
  display_name: string
  legal_name?: string
  siren?: string
  website_url?: string
  email_domain?: string
  size_label?: string
  establishments?: { name: string; siret: string; city: string; kind?: string; is_primary: boolean }[]
}

export function createCompany(page: Page, company: CompanySeed): Promise<{ id: string }> {
  return post(page, '/api/companies', company)
}

export function createReferent(page: Page, referent: { first_name: string; last_name: string; email: string | null }) {
  return post<{ id: string }>(page, '/api/settings/referents', referent)
}
