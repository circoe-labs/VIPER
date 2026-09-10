import { expect, type Page, test } from '@playwright/test'

// Screenshots for design review land in the git-ignored test-results/ folder (recreated on every run).
const SCREENSHOTS = 'test-results/screenshots'

test.use({ viewport: { width: 1440, height: 900 } })

const CANVAS = { dark: 'rgb(10, 11, 13)', light: 'rgb(244, 247, 247)' }

// Draws the rendered logo onto a canvas and reads its corner alpha: 0 means no background box is baked in.
async function logoCornerAlpha(page: Page) {
  return page.locator('.sidebar__brand img').evaluate(async (img: HTMLImageElement) => {
    await img.decode()
    const canvas = document.createElement('canvas')
    canvas.width = img.naturalWidth
    canvas.height = img.naturalHeight
    const context = canvas.getContext('2d')
    if (!context) throw new Error('2D canvas unavailable')
    context.drawImage(img, 0, 0)
    const w = canvas.width - 1
    const h = canvas.height - 1
    return [
      [0, 0],
      [w, 0],
      [0, h],
      [w, h],
    ].map(([x, y]) => context.getImageData(x ?? 0, y ?? 0, 1, 1).data[3])
  })
}

test('shell renders in dark then light, remembers the choice and uses the contrasting logo', async ({ page }) => {
  await page.goto('/')
  const html = page.locator('html')
  const logo = page.locator('.sidebar__brand img')

  await expect(html).toHaveAttribute('data-theme', 'dark')
  await expect(page.locator('body')).toHaveCSS('background-color', CANVAS.dark)
  await expect(logo).toHaveAttribute('src', /viper-lockup-white/)
  expect(await logoCornerAlpha(page)).toEqual([0, 0, 0, 0])
  expect(await page.evaluate(async () => (await document.fonts.ready).check('16px "Inter Variable"'))).toBe(true)
  await page.screenshot({ path: `${SCREENSHOTS}/shell-dark.png` })

  await page.getByRole('button', { name: 'Passer au thème clair' }).click()
  await page.reload()

  await expect(html).toHaveAttribute('data-theme', 'light')
  await expect(page.locator('body')).toHaveCSS('background-color', CANVAS.light)
  await expect(logo).toHaveAttribute('src', /viper-lockup-black/)
  expect(await logoCornerAlpha(page)).toEqual([0, 0, 0, 0])
  await page.screenshot({ path: `${SCREENSHOTS}/shell-light.png` })
})

test('collapsed sidebar swaps the lockup for the mark and keeps accessible labels', async ({ page }) => {
  await page.goto('/prospection')
  await page.getByRole('button', { name: 'Réduire la navigation' }).click()

  await expect(page.locator('.sidebar__brand img')).toHaveAttribute('src', /viper-mark-white/)
  const navigation = page.getByRole('navigation', { name: 'Navigation principale' })
  await expect(navigation.getByRole('link', { name: 'Prospection' })).toHaveAttribute('aria-current', 'page')
  await page.screenshot({ path: `${SCREENSHOTS}/shell-dark-collapsed.png` })
})

test('favicons follow the browser colour scheme and are served', async ({ page, request }) => {
  await page.goto('/')
  const hrefs = await page
    .locator('link[rel="icon"]')
    .evaluateAll((links) => links.map((link) => [link.getAttribute('media'), link.getAttribute('href')]))
  expect(hrefs).toEqual([
    ['(prefers-color-scheme: dark)', '/favicon-dark.png'],
    ['(prefers-color-scheme: light)', '/favicon-light.png'],
  ])
  for (const [, href] of hrefs) {
    const response = await request.get(href ?? '')
    expect(response.headers()['content-type']).toBe('image/png')
  }
})

test('no horizontal overflow at the smallest supported laptop width', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto('/database')
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(overflow).toBe(0)
})

for (const theme of ['dark', 'light'] as const) {
  test(`component showcase screenshot (${theme})`, async ({ page }) => {
    await page.addInitScript((value) => {
      window.localStorage.setItem('viper.theme', value)
    }, theme)
    await page.goto('/_dev/ui')
    await expect(page.getByRole('heading', { level: 1, name: 'Composants' })).toBeVisible()
    await page.screenshot({ path: `${SCREENSHOTS}/showcase-${theme}.png`, fullPage: true })

    await page.getByRole('button', { name: 'Ouvrir un panneau' }).click()
    await expect(page.getByRole('dialog', { name: 'Éditeur' })).toBeVisible()
    await expect(page.getByRole('textbox', { name: 'Champ', exact: true })).toBeFocused()
    await page.screenshot({ path: `${SCREENSHOTS}/drawer-${theme}.png`, animations: 'disabled' })
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toHaveCount(0)
  })
}
