import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import { SHELL_API } from '../../test/homeApi'
import { type ApiReply, renderApp, stubApi } from '../../test/render'
import { COMMON, detail, MISSION } from '../missionTestData'

const CAPABILITIES = { assistant: true, speech: false }

function turnReply(body: Record<string, unknown>): ApiReply {
  return [200, { model: 'fake', finalize: false, actions: [], ...body }]
}

async function openVoice(replies: Record<string, ApiReply> = {}) {
  const fetchMock = stubApi({
    ...SHELL_API,
    ...COMMON,
    'GET /api/missions': [200, { items: [], total: 0 }],
    'GET /api/missions/assistant/capabilities': [200, CAPABILITIES],
    'POST /api/missions': [201, detail()],
    [`GET /api/missions/${MISSION}`]: [200, detail()],
    ...replies,
  })
  const user = userEvent.setup()
  renderApp('/missions')
  await user.click((await screen.findAllByRole('button', { name: 'Nouvelle mission' }))[0] as HTMLElement)
  const dialog = await screen.findByRole('dialog', { name: 'Créer mission' })
  return { fetchMock, user, dialog }
}

function calls(fetchMock: ReturnType<typeof stubApi>, method: string, path: string) {
  return fetchMock.mock.calls.filter(([url, init]) => url.endsWith(path) && (init?.method ?? 'GET') === method)
}

async function startVoice(user: ReturnType<typeof userEvent.setup>, dialog: HTMLElement) {
  const button = await within(dialog).findByRole('button', { name: 'Créer à la voix' })
  await waitFor(() => {
    expect(button).toBeEnabled()
  })
  await user.click(button)
  return screen.findByRole('dialog', { name: 'Assistant vocal de création de mission' })
}

describe('voice mission assistant', () => {
  it('is disabled, with the reason, when the AI is not configured', async () => {
    const { dialog } = await openVoice({
      'GET /api/missions/assistant/capabilities': [200, { assistant: false, speech: false }],
    })
    expect(await within(dialog).findByRole('button', { name: 'Créer à la voix' })).toBeDisabled()
    expect(within(dialog).getByText(/clé et le modèle IA/)).toBeInTheDocument()
  })

  it('applies the assistant’s edits to the same form and closing creates nothing', async () => {
    const { fetchMock, user, dialog } = await openVoice({
      'POST /api/missions/assistant/turn': turnReply({
        reply: 'Veille hebdomadaire notée. Quelles sociétés surveiller ?',
        actions: [
          { tool: 'set_name', args: { name: 'Veille Normandie' }, summary: 'Nom : Veille Normandie' },
          { tool: 'set_category', args: { category_id: 'cat-signals' }, summary: 'Catégorie : Signaux' },
          { tool: 'set_recurrence', args: { recurring: true, interval_count: 1, interval_unit: 'weeks' }, summary: 'Exécution : récurrente' },
        ],
      }),
    })
    const overlay = await startVoice(user, dialog)
    // No microphone API in the test browser: the typed fallback is announced and works.
    expect(within(overlay).getByText('Décrivez la mission que vous voulez créer.')).toBeInTheDocument()
    expect(within(overlay).getByText(/reconnaissance vocale n’est pas disponible/)).toBeInTheDocument()

    await user.type(within(overlay).getByRole('textbox', { name: 'Écrire votre demande' }), 'Une veille chaque semaine en Normandie')
    await user.click(within(overlay).getByRole('button', { name: 'Envoyer' }))

    expect(await within(overlay).findByText(/Quelles sociétés surveiller/)).toBeInTheDocument()
    expect(within(overlay).getByText('Catégorie : Signaux')).toBeInTheDocument()
    expect(within(overlay).getByText('Une veille chaque semaine en Normandie')).toBeInTheDocument()
    // The draft the assistant read is the form's own state; the question is the person's sentence.
    const [, init] = calls(fetchMock, 'POST', '/api/missions/assistant/turn')[0] ?? []
    const sent = JSON.parse(init?.body as string) as { messages: { role: string; content: string }[]; draft: { name: string } }
    expect(sent.messages).toEqual([{ role: 'user', content: 'Une veille chaque semaine en Normandie' }])
    expect(sent.draft.name).toBe('')

    await user.click(within(overlay).getByRole('button', { name: 'Fermer l’assistant vocal' }))
    expect(screen.queryByRole('dialog', { name: 'Assistant vocal de création de mission' })).not.toBeInTheDocument()
    expect(within(dialog).getByRole('textbox', { name: /Nom/ })).toHaveValue('Veille Normandie')
    expect(within(dialog).getByRole('radio', { name: /Signaux/ })).toBeChecked()
    expect(calls(fetchMock, 'POST', '/api/missions')).toHaveLength(0)
  })

  it('says what is missing when asked to create an incomplete draft, and creates nothing', async () => {
    const { fetchMock, user, dialog } = await openVoice({
      'POST /api/missions/assistant/turn': turnReply({
        reply: 'Je la crée.',
        finalize: true,
        actions: [{ tool: 'set_category', args: { category_id: 'cat-signals' }, summary: 'Catégorie : Signaux' }],
      }),
    })
    const overlay = await startVoice(user, dialog)
    await user.type(within(overlay).getByRole('textbox', { name: 'Écrire votre demande' }), 'Crée une veille')
    await user.click(within(overlay).getByRole('button', { name: 'Envoyer' }))
    expect(await within(overlay).findByText(/Je ne peux pas encore la créer/)).toBeInTheDocument()
    expect(calls(fetchMock, 'POST', '/api/missions')).toHaveLength(0)
  })

  it('finalizes through the form’s own validated save', async () => {
    const { fetchMock, user, dialog } = await openVoice({
      'POST /api/missions/assistant/turn': turnReply({
        reply: 'C’est parti.',
        finalize: true,
        actions: [
          { tool: 'set_name', args: { name: 'Découverte Rouen' }, summary: 'Nom : Découverte Rouen' },
          { tool: 'set_category', args: { category_id: 'cat-prospection', result_kind: 'companies' }, summary: 'Catégorie : Prospection' },
        ],
      }),
    })
    const overlay = await startVoice(user, dialog)
    await user.type(within(overlay).getByRole('textbox', { name: 'Écrire votre demande' }), 'Go, crée-la')
    await user.click(within(overlay).getByRole('button', { name: 'Envoyer' }))
    await waitFor(() => {
      expect(calls(fetchMock, 'POST', '/api/missions')).toHaveLength(1)
    })
    const [, init] = calls(fetchMock, 'POST', '/api/missions')[0] ?? []
    const body = JSON.parse(init?.body as string) as Record<string, unknown>
    expect(body).toMatchObject({ name: 'Découverte Rouen', category_id: 'cat-prospection', result_kind: 'companies', prompt: null })
  })

  it('shows a typed failure on screen and offers to retry', async () => {
    const { user, dialog } = await openVoice({
      'POST /api/missions/assistant/turn': [502, { detail: { code: 'ai_upstream_error', message: 'x' } }],
    })
    const overlay = await startVoice(user, dialog)
    await user.type(within(overlay).getByRole('textbox', { name: 'Écrire votre demande' }), 'Bonjour')
    await user.click(within(overlay).getByRole('button', { name: 'Envoyer' }))
    expect(await within(overlay).findByRole('alert')).toHaveTextContent('Le service d’IA est injoignable')
    expect(within(overlay).getByRole('button', { name: 'Réessayer' })).toBeInTheDocument()
  })
})
