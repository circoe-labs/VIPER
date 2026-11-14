import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'
import { execFileSync } from 'node:child_process'

import { uniqueSuffix } from './data'
import { BACKEND_DIR, E2E_DATABASE_URL, E2E_USER, PYTHON } from './env'
import { signIn } from './session'

// The pilot account is a plain member; the administration pages need an administrator. The spec promotes it through the
// database for its own duration and puts it back (run it on its own: `playwright test e2e/mission-configuration.spec.ts`).
function setRole(role: 'admin' | 'member') {
  const code = [
    'import sys',
    'from sqlalchemy import create_engine, text',
    'e = create_engine(sys.argv[1])',
    'with e.begin() as c:',
    '    c.execute(text("UPDATE users SET role = :r WHERE email = :m"), {"r": sys.argv[2], "m": sys.argv[3]})',
  ].join(String.fromCharCode(10))
  execFileSync(PYTHON, ['-c', code, E2E_DATABASE_URL, role, E2E_USER.email], { cwd: BACKEND_DIR })
}

test.beforeAll(() => {
  setRole('admin')
})
test.afterAll(() => {
  setRole('member')
})

// Mission configuration (task viper_mission_agent_configuration_v2, Slice 08): the administration surfaces (category,
// skill, source), the grouped navigation, the creator-prompt setting, the category choice in the mission dialog and the
// voice entry (no microphone: typed fallback, then cancel). Real backend and database, no model involved.

test.use({ viewport: { width: 1440, height: 900 } })
test.setTimeout(120_000)
// One worker for the file: the promotion above must outlive every test of it.
test.describe.configure({ mode: 'serial' })

const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']

test('an administrator manages categories, skills and sources, and the mission dialog offers the new category', async ({
  page,
}) => {
  const suffix = uniqueSuffix()
  await signIn(page)
  await page.goto('/administration/categories')
  await expect(page.getByRole('heading', { level: 1, name: 'Catégories de mission' })).toBeVisible()
  // Grouped navigation: the administration group and its three entries.
  const nav = page.getByRole('navigation').first()
  await expect(nav.getByRole('link', { name: 'Skills' })).toBeVisible()
  await expect(nav.getByRole('link', { name: 'Sources' })).toBeVisible()
  // The five seeded categories are there.
  await expect(page.locator('ul.adm-grid[aria-label="Catégories de mission"] > li')).toHaveCount(5, {
    timeout: 15_000,
  })

  // A skill.
  await page.goto('/administration/skills')
  await page.getByRole('button', { name: 'Nouveau skill' }).click()
  const skillName = `Skill E2E ${suffix}`
  await page.getByLabel('Nom').fill(skillName)
  await page.getByLabel('Instructions').fill('Cite toujours l’URL exacte.')
  await page.getByRole('button', { name: 'Enregistrer' }).click()
  await expect(page.getByRole('list', { name: 'Skills' }).getByText(skillName)).toBeVisible()

  // A source root, then a sub-source.
  await page.goto('/administration/sources')
  await page.getByRole('button', { name: /Nouvelle source|Ajouter une source/ }).first().click()
  const host = `e2e-${suffix.toLowerCase()}.example.com`
  await page.getByLabel('Adresse').fill(`https://${host}`)
  await page.getByLabel('Nom (facultatif)').fill(`Source E2E ${suffix}`)
  await page.getByRole('button', { name: 'Enregistrer' }).click()
  await expect(page.getByRole('list', { name: 'Bibliothèque de sources' }).getByText(`Source E2E ${suffix}`)).toBeVisible()

  // A category with its own colour and glyph, using that skill.
  await page.goto('/administration/categories')
  await page.getByRole('button', { name: 'Nouvelle catégorie' }).click()
  const categoryName = `Catégorie E2E ${suffix}`
  await page.getByRole('dialog').getByRole('textbox', { name: /^Nom/ }).fill(categoryName)
  await page.getByLabel('Consigne générale').fill('Consigne de la catégorie E2E.')
  await page.getByRole('radio', { name: 'Radar' }).click()
  await page.getByRole('button', { name: 'Enregistrer' }).click()
  await expect(page.getByRole('list', { name: 'Catégories de mission' }).getByText(categoryName)).toBeVisible()

  const { violations } = await new AxeBuilder({ page }).withTags(WCAG).analyze()
  expect(violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')).toEqual([])

  // The mission dialog offers the new category.
  await page.goto('/missions')
  await page.getByRole('button', { name: 'Nouvelle mission' }).first().click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await expect(page.getByRole('dialog').getByText(categoryName).first()).toBeVisible()
})

test('the creator prompt is edited in Settings and reset to its default', async ({ page }) => {
  await signIn(page)
  await page.goto('/settings/mission-creator')
  const field = page.getByRole('textbox', { name: 'Comportement de l’assistant' })
  await expect(field).toBeVisible()
  const marker = `Toujours dire bonjour ${uniqueSuffix()}.`
  await field.fill(marker)
  await page.getByRole('button', { name: /Enregistrer/ }).first().click()
  await page.reload()
  await expect(page.getByRole('textbox', { name: 'Comportement de l’assistant' })).toHaveValue(marker)
  await page.getByRole('button', { name: 'Rétablir le texte par défaut' }).click()
  await page.getByRole('button', { name: 'Enregistrer' }).click()
  await page.reload()
  await expect(page.getByText('Texte par défaut de VIPER.')).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'Comportement de l’assistant' })).not.toHaveValue(marker)
})

test('the voice entry falls back to typing without a microphone, and cancelling leaves the draft untouched', async ({
  page,
}) => {
  await signIn(page)
  await page.goto('/missions')
  await page.getByRole('button', { name: 'Nouvelle mission' }).first().click()
  const dialog = page.getByRole('dialog').first()
  await dialog.getByRole('textbox', { name: /Nom/ }).first().fill('Brouillon intact')
  const entry = page.getByRole('button', { name: 'Créer à la voix' })
  await expect(entry).toBeVisible()
  const hint = page.locator('.voice-entry__hint')
  await expect(entry.or(hint.filter({ hasText: 'Paramètres › Connexions' }))).toBeEnabled({ timeout: 15_000 }).catch(() => undefined)
  if (await entry.isDisabled()) {
    // No model configured on this server: the entry says why instead of failing.
    await expect(hint).toContainText('Paramètres › Connexions')
    return
  }
  await entry.click()
  const overlay = page.getByRole('dialog', { name: 'Assistant vocal de création de mission' })
  await expect(overlay).toBeVisible()
  // The typed fallback is always there; speech is either offered or declared unavailable.
  await expect(overlay.getByRole('textbox', { name: 'Écrire votre demande' })).toBeVisible()
  const { violations } = await new AxeBuilder({ page }).include('.voice').withTags(WCAG).analyze()
  expect(violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')).toEqual([])
  await overlay.getByRole('button', { name: 'Fermer l’assistant vocal' }).click()
  await expect(overlay).toBeHidden()
  await expect(dialog.getByRole('textbox', { name: /Nom/ }).first()).toHaveValue('Brouillon intact')
})
