import AxeBuilder from '@axe-core/playwright'
import { expect, type Page, test } from '@playwright/test'

import { createCompany, post, uniqueSuffix } from './data'
import { E2E_API_PORT } from './env'
import { signIn } from './session'

// Mission supervision, end to end (Slice 10): a mission is created and run through the real API, an agent works it
// through the real /mcp endpoint (claim, log, heartbeat, submit), and the operator supervises it in the browser:
// live activity, review queue (accept / reject, the reject reason only after « Rejeter »), statistics. Then axe on the
// four tabs and the review dialog. No LLM is involved: the agent is a scripted JSON-RPC client, which proves the
// plumbing, not the compliance of a real model with the logging guidance.

test.use({ viewport: { width: 1440, height: 900 } })

const MCP_URL = `http://127.0.0.1:${String(E2E_API_PORT)}/mcp`
const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']

interface Tool {
  structuredContent: Record<string, unknown>
  isError: boolean
}

interface Claimed {
  task_id: string
  claim_id: string
  telemetry?: unknown
}

async function tool(page: Page, token: string, name: string, args: Record<string, unknown>): Promise<Tool> {
  const response = await page.request.post(MCP_URL, {
    headers: { Authorization: `Bearer ${token}` },
    data: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
  })
  expect(response.status()).toBe(200)
  return ((await response.json()) as { result: Tool }).result
}

async function ok(page: Page, token: string, name: string, args: Record<string, unknown>) {
  const result = await tool(page, token, name, args)
  expect(result.isError, JSON.stringify(result.structuredContent)).toBe(false)
  return result.structuredContent
}

async function expectAccessible(page: Page, name: string, include?: string) {
  // The dialog fades in: axe must not sample a mid-fade colour (a cold first run did, on the danger button).
  await page.waitForFunction(() => document.getAnimations().every((animation) => animation.playState !== 'running'))
  const builder = new AxeBuilder({ page }).withTags(WCAG)
  const { violations } = await (include ? builder.include(include) : builder).analyze()
  const blocking = violations.filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
  for (const violation of violations.filter((item) => !blocking.includes(item))) {
    test.info().annotations.push({ type: 'axe', description: `${name}: ${violation.id} (${String(violation.impact)})` })
  }
  const summary = blocking.map(
    (violation) => `${violation.id}: ${violation.nodes.map((node) => node.target.join(' ')).join(' | ')}`,
  )
  expect(summary, `${name}: serious/critical axe violations`).toEqual([])
}

// The claim queue is global (not scoped to a mission or organization) and the specs run in parallel on one database:
// a claim may return another spec's task. Give such a task back and try again until the claim is one of ours.
async function claimOwn(page: Page, token: string, companyIds: string[]): Promise<Claimed> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const claimed = (await ok(page, token, 'viper_claim_task', { task_types: ['update_company'] })) as unknown as Partial<Claimed> & {
      subject?: { company_id?: string }
    }
    if (claimed.task_id === undefined || claimed.claim_id === undefined) {
      await page.waitForTimeout(250)
      continue
    }
    if (companyIds.includes(claimed.subject?.company_id ?? '')) return { ...claimed, task_id: claimed.task_id, claim_id: claimed.claim_id }
    await ok(page, token, 'viper_release_task', { task_id: claimed.task_id, claim_id: claimed.claim_id })
    await page.waitForTimeout(100 + Math.floor(Math.random() * 300))
  }
  throw new Error('no task of this spec could be claimed')
}

const ids = (claimed: Claimed) => ({ task_id: claimed.task_id, claim_id: claimed.claim_id })

test('an operator supervises a mission worked by an agent, from claim to review and statistics', async ({ page }) => {
  await signIn(page)
  const suffix = uniqueSuffix()
  const accepted = await createCompany(page, { display_name: `Supervision A ${suffix}` })
  const rejected = await createCompany(page, { display_name: `Supervision B ${suffix}` })

  // An agent identity (a worker token of the signed-in person) and a mission with two targets, run now.
  const created = await post<{ token: string }>(page, '/api/settings/mcp/agents', {
    label: `Agent supervision ${suffix}`,
    mode: 'worker',
  })
  const detail = await post<{ card: { id: string } }>(page, '/api/missions', {
    name: `Supervision ${suffix}`,
    type: 'enrichment',
    prompt: 'Complète le site web de ces sociétés.',
    targets: [accepted, rejected].map((company) => ({ kind: 'company', id: company.id })),
    result_kind: 'enrichment',
    run_now: true,
  })
  const base = `/missions/${detail.card.id}`

  // Before any agent: honest empty state, no invented activity.
  await page.goto(`${base}?tab=activity`)
  await expect(page.getByRole('tab', { name: 'Activité' })).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByText('Recherche du site officiel.')).toHaveCount(0)

  // The agent claims through the real MCP endpoint: the session opens by itself, with the logging guidance.
  const first = await claimOwn(page, created.token, [accepted.id, rejected.id])
  const second = await claimOwn(page, created.token, [accepted.id, rejected.id])
  expect(first.telemetry).toBeTruthy()

  await ok(page, created.token, 'viper_log_mission_activity', {
    ...ids(first),
    event_type: 'search',
    message: 'Recherche du site officiel.',
  })
  await ok(page, created.token, 'viper_log_mission_activity', {
    ...ids(first),
    event_type: 'source_opened',
    message: 'Page ouverte : mentions légales.',
    source_url: 'https://exemple.example/mentions',
  })
  await ok(page, created.token, 'viper_heartbeat_task', ids(first))

  await page.reload()
  await expect(page.getByText('Recherche du site officiel.')).toBeVisible()
  await expect(page.getByText('Page ouverte : mentions légales.')).toBeVisible()
  await expect(page.getByRole('link', { name: /exemple\.example/ }).first()).toBeVisible()
  await expect(page.getByText('En cours').first()).toBeVisible()
  await expectAccessible(page, 'mission — Activité')

  // Submit both: the proposals wait for the operator, nothing is applied.
  for (const claimed of [first, second]) {
    await ok(page, created.token, 'viper_submit_task_result', {
      ...ids(claimed),
      result: { website_url: 'https://exemple.example', confidence: 82, notes: 'Site confirmé sur deux pages.' },
    })
  }

  await page.goto(`${base}?tab=results`)
  await expect(page.getByRole('tab', { name: /Résultats/ })).toHaveAttribute('aria-selected', 'true')
  const cards = page.getByRole('list', { name: 'Résultats des agents' }).getByRole('button')
  await expect(cards).toHaveCount(2)
  await expectAccessible(page, 'mission — Résultats')

  // Review 1: accept. No reason field in the normal view.
  await cards.first().click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  await expect(dialog.getByLabel('Motif du rejet')).toHaveCount(0)
  await expectAccessible(page, 'dialogue de relecture', '[role="dialog"]')
  await dialog.getByRole('button', { name: /^Accepter la sélection/ }).click()
  await expect(dialog).toBeHidden()

  // Review 2: the reason appears only after « Rejeter », and is required.
  await expect(cards).toHaveCount(1)
  await cards.first().click()
  await expect(dialog).toBeVisible()
  await expect(dialog.getByLabel('Motif du rejet')).toHaveCount(0)
  await dialog.getByRole('button', { name: 'Rejeter' }).click()
  const reason = dialog.getByLabel('Motif du rejet')
  await expect(reason).toBeFocused()
  await expect(dialog.getByRole('button', { name: 'Confirmer le rejet' })).toBeVisible()
  await expectAccessible(page, 'dialogue de relecture — rejet', '[role="dialog"]')
  await reason.fill('Site non vérifiable.')
  await dialog.getByRole('button', { name: 'Confirmer le rejet' }).click()
  await expect(dialog).toBeHidden()
  await expect(cards).toHaveCount(0)

  // Statistics follow the decisions: 1 accepted, 1 rejected.
  await page.goto(`${base}?tab=stats`)
  await expect(page.getByRole('tab', { name: 'Statistiques' })).toHaveAttribute('aria-selected', 'true')
  const acceptance = page.locator('dt', { hasText: 'Taux d’acceptation' })
  await expect(acceptance).toBeVisible()
  await expect(acceptance.locator('xpath=..')).toContainText('50')
  await expectAccessible(page, 'mission — Statistiques')

  // The agent's end of work, and the overview.
  await ok(page, created.token, 'viper_end_mission_session', { task_id: first.task_id })
  await page.goto(base)
  await expect(page.getByRole('tab', { name: /Vue d.ensemble/ })).toHaveAttribute('aria-selected', 'true')
  await expectAccessible(page, 'mission — Vue d’ensemble')
})

// The redesigned Missions list -> mission -> Statistiques -> Résultats path, driven by clicks (no deep links), with the
// active / inactive (paused) switch on both surfaces and a pending review that is accepted from the dialog.
test('the Missions list leads to a mission, its statistics and its pending review; active and inactive states', async ({
  page,
}) => {
  await signIn(page)
  const suffix = uniqueSuffix()
  const company = await createCompany(page, { display_name: `Parcours ${suffix}` })
  const created = await post<{ token: string }>(page, '/api/settings/mcp/agents', {
    label: `Agent parcours ${suffix}`,
    mode: 'worker',
  })
  const name = `Parcours ${suffix}`
  const detail = await post<{ card: { id: string } }>(page, '/api/missions', {
    name,
    type: 'enrichment',
    prompt: 'Complète le site web de cette société.',
    targets: [{ kind: 'company', id: company.id }],
    result_kind: 'enrichment',
    run_now: true,
  })

  // A proposal waits for review.
  const claimed = await claimOwn(page, created.token, [company.id])
  await ok(page, created.token, 'viper_submit_task_result', {
    ...ids(claimed),
    result: { website_url: 'https://exemple.example', confidence: 80, notes: 'Site confirmé.' },
  })

  // List: KPI tiles, toolbar, the card with its status and its pending-review chip; axe.
  await page.goto('/missions')
  await expect(page.getByRole('heading', { name: 'Missions', level: 1 })).toBeVisible()
  await expect(page.getByLabel('Indicateurs des missions')).toBeVisible()
  await expect(page.getByRole('group', { name: 'Filtrer et trier les missions' })).toBeVisible()
  const card = page.getByRole('link', { name: new RegExp(name) })
  await expect(card).toBeVisible()
  await expect(card.getByText('Active', { exact: true })).toBeVisible()
  await expect(card.getByText('1 à relire')).toBeVisible()
  await expectAccessible(page, 'liste des missions')

  // Inactive (paused) from the list switch, then active again.
  const toggle = page.getByRole('switch', { name: `Mission ${name} active` })
  await expect(toggle).toBeChecked()
  await toggle.click()
  await expect(toggle).not.toBeChecked()
  await expect(card.getByText('Inactive', { exact: true })).toBeVisible()
  await expect(card.getByText('Inactive : fermée aux agents')).toBeVisible()
  await expectAccessible(page, 'liste des missions — inactive')

  // Open the mission: the header shows the paused state and offers « Activer »; reactivate it there.
  await card.click()
  await expect(page).toHaveURL(new RegExp(`/missions/${detail.card.id}`))
  await expect(page.getByRole('heading', { name, level: 1 })).toBeVisible()
  const chips = page.getByRole('list', { name: 'Caractéristiques de la mission' })
  await expect(chips.getByText('Inactive', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Activer' }).click()
  await expect(chips.getByText('Active', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Désactiver' })).toBeVisible()
  await expectAccessible(page, 'mission — Vue d’ensemble (active)')

  // Statistiques, by clicking the tab.
  await page.getByRole('tab', { name: 'Statistiques' }).click()
  await expect(page.getByRole('tab', { name: 'Statistiques' })).toHaveAttribute('aria-selected', 'true')
  await expect(page).toHaveURL(/tab=stats/)
  await expect(page.locator('dt', { hasText: 'Taux d’acceptation' })).toBeVisible()
  await expectAccessible(page, 'mission — Statistiques (parcours)')

  // Résultats: the pending proposal is accepted from the review dialog.
  await page.getByRole('tab', { name: /Résultats/ }).click()
  const cards = page.getByRole('list', { name: 'Résultats des agents' }).getByRole('button')
  await expect(cards).toHaveCount(1)
  await cards.first().click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: /^Accepter la sélection/ }).click()
  await expect(dialog).toBeHidden()
  await expect(cards).toHaveCount(0)

  // Back on the list: nothing left to review for this mission.
  await page.goto('/missions')
  await expect(page.getByRole('link', { name: new RegExp(name) }).getByText('1 à relire')).toHaveCount(0)
})
