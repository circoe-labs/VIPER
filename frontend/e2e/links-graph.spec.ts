import { expect, test } from '@playwright/test'

import { createCompany, post, uniqueSuffix } from './data'
import { SCREENSHOTS, useTheme } from './helpers'
import { signIn } from './session'

// Relations between people and the Prospection graph, against the real backend. Every person, company and link is
// this test's own (invented, run-unique), so nothing else sees them.

test.use({ viewport: { width: 1440, height: 900 } })

async function prospect(page: Parameters<typeof post>[0], first: string, last: string, companyId: string) {
  return post<{ id: string }>(page, '/api/prospects', {
    first_name: first,
    last_name: last,
    company_id: companyId,
    provenance: { legal_basis_or_collection_context: 'Données synthétiques de test E2E' },
  })
}

test('a relation is added from the sheet and the graph groups the people by company', async ({ page }) => {
  test.setTimeout(90_000)
  await signIn(page)
  const tag = uniqueSuffix()
  const acme = await createCompany(page, { display_name: `Acme Graphe ${tag}` })
  const bravo = await createCompany(page, { display_name: `Bravo Graphe ${tag}` })
  const anne = await prospect(page, 'Anne', `Lien${tag}`, acme.id)
  const paul = await prospect(page, 'Paul', `Lien${tag}`, acme.id)
  const lea = await prospect(page, 'Léa', `Lien${tag}`, bravo.id)
  const members = (await (await page.request.get('/api/organizations/members')).json()) as { id: string; display_name: string }[]
  const member = members[0]
  if (!member) throw new Error('No member to link to.')
  const relation = `frère E2E ${tag}`

  // Added from the sheet.
  await page.goto(`/prospection?prospect=${anne.id}`)
  const card = page.getByRole('dialog').getByRole('region', { name: 'Relations' })
  await expect(card.getByText('Aucune relation enregistrée pour l’instant.')).toBeVisible()
  await card.getByRole('combobox', { name: 'Lié à' }).click()
  await page.getByRole('option', { name: new RegExp(member.display_name) }).click()
  await card.getByLabel('Nature du lien').fill(relation)
  await card.getByRole('button', { name: 'Ajouter le lien' }).click()
  await expect(card.getByRole('list', { name: 'Relations du prospect' })).toContainText(relation)

  // Added through the API: a friend inside the company, and a weaker acquaintance in the other one.
  await post(page, '/api/links', { a: { kind: 'prospect', id: anne.id }, b: { kind: 'prospect', id: paul.id }, relation: 'amis', score: 78 })
  await post(page, '/api/links', { a: { kind: 'prospect', id: lea.id }, b: { kind: 'member', id: member.id }, relation: 'connaissance', score: 25 })
  await post(page, '/api/links', { a: { kind: 'prospect', id: lea.id }, b: { kind: 'prospect', id: paul.id }, relation: 'anciens collègues', score: 60 })

  for (const theme of ['dark', 'light'] as const) {
    await useTheme(page, theme)
    await page.goto('/prospection/graphe')
    await expect(page.getByRole('heading', { level: 1, name: 'Graphe de prospection' })).toBeVisible()
    const graph = page.getByRole('img', { name: /Graphe des relations/ })
    await expect(graph.getByText(`Acme Graphe ${tag}`)).toBeVisible()
    await expect(graph.getByText(`Bravo Graphe ${tag}`)).toBeVisible()
    await page.getByRole('switch', { name: 'Étiquettes des liens' }).check()
    await page.screenshot({ path: `${SCREENSHOTS}/graph-${theme}.png` })
  }

  // The strength filter hides the weak links; the details panel lists the person's links.
  await page.getByLabel(/Force minimale/).fill('70')
  await expect(page.getByRole('img', { name: /Graphe des relations/ }).getByText(`Bravo Graphe ${tag}`)).toHaveCount(0)
  await page.getByRole('button', { name: new RegExp(`Anne Lien${tag}`) }).click()
  await expect(page.getByRole('complementary', { name: new RegExp(`Relations de Anne Lien${tag}`) })).toContainText('amis')
})
