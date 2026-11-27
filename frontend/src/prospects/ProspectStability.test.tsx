import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { apiGet, apiRequest, RequestTimeoutError } from '../api/client'
import { createQueryClient } from '../api/queryClient'
import { signOutLocally } from '../auth/session'
import { company } from '../test/companiesApi'
import { companySummary, prospectDetail, stubProspectsApi } from '../test/prospectsApi'
import { editorReady, editSection } from '../test/prospectEditorUi'
import { fakeQueue, renderProspectEditor } from '../test/renderProspectEditor'
import { keepDraft, keptDraft } from './draftStorage'
import { prospectRefusal } from './messages'
import { draftFromProspect } from './prospectForm'

// « Le logiciel s'est figé » : nothing typed is lost across a reload, and no wait lasts forever.

const employer = company('Transports Exemple SARL')
const person = () => prospectDetail({ first_name: 'Anne', last_name: 'Premier', company: companySummary(employer) })

async function typeFirstName(value: string) {
  await editorReady()
  await editSection('Identité')
  const field = screen.getByRole('textbox', { name: 'Prénom' })
  await userEvent.clear(field)
  await userEvent.type(field, value)
}

describe('Prospect editor — unsaved input', () => {
  it('comes back after a reload, and is forgotten once saved', async () => {
    const first = person()
    stubProspectsApi({ details: [first], companies: [employer] })
    const opened = renderProspectEditor(first.id)
    await typeFirstName('Annie')
    opened.unmount()

    renderProspectEditor(first.id)

    expect(await screen.findByText('Saisie non enregistrée restaurée')).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Prénom' })).toHaveValue('Annie')

    await userEvent.click(screen.getByRole('button', { name: 'Enregistrer' }))
    expect(await screen.findByText('Prospect enregistré.')).toBeInTheDocument()
    expect(keptDraft(first.id)).toBeNull()
  })

  it('is only offered when the prospect changed since it was typed', async () => {
    const first = person()
    stubProspectsApi({ details: [first], companies: [employer] })
    const typed = draftFromProspect(first)
    keepDraft(first.id, { version: 'older', draft: { ...typed, first_name: 'Annie' }, editing: ['identity'] })

    renderProspectEditor(first.id)

    await userEvent.click(await screen.findByRole('button', { name: 'Restaurer ma saisie' }))
    expect(screen.getByRole('textbox', { name: 'Prénom' })).toHaveValue('Annie')
  })

  it('is dropped when abandoned on purpose, and the question does not stay over the next prospect', async () => {
    const first = person()
    stubProspectsApi({ details: [first], companies: [employer] })
    const { queue } = fakeQueue([first.id, 'autre'])
    const { onNavigate } = renderProspectEditor(first.id, queue)
    await typeFirstName('Annie')

    await userEvent.click(screen.getByRole('button', { name: 'Prospect suivant' }))
    const confirm = screen.getByRole('dialog', { name: 'Abandonner les modifications ?' })
    await userEvent.click(within(confirm).getByRole('button', { name: 'Changer de prospect sans enregistrer' }))

    expect(onNavigate).toHaveBeenCalledWith('autre', { page: 1 })
    expect(screen.queryByRole('dialog', { name: 'Abandonner les modifications ?' })).not.toBeInTheDocument()
    expect(keptDraft(first.id)).toBeNull()
  })

  it('survives an expired session and is forgotten at sign-out', () => {
    keepDraft('abc', { version: 'v', draft: draftFromProspect(person()), editing: [] })

    signOutLocally(createQueryClient(), 'expired')
    expect(keptDraft('abc')).not.toBeNull()
    signOutLocally(createQueryClient(), 'signed-out')
    expect(keptDraft('abc')).toBeNull()
  })

  it('leaves the page scrollable once the sheet and its confirmation closed together', async () => {
    const first = person()
    stubProspectsApi({ details: [first], companies: [employer] })
    const view = renderProspectEditor(first.id)
    await typeFirstName('Annie')
    await userEvent.keyboard('{Escape}')
    expect(screen.getByRole('dialog', { name: 'Abandonner les modifications ?' })).toBeInTheDocument()
    expect(document.body.style.overflow).toBe('hidden')

    view.unmount()

    expect(document.body.style.overflow).toBe('')
  })
})

describe('Request deadlines', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  function stubSilentServer() {
    const fetchMock = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            reject(init.signal?.reason as Error)
          })
        }),
    )
    vi.stubGlobal('fetch', fetchMock)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    return fetchMock
  }

  it('ends a read that never answers, without repeating it', async () => {
    vi.useFakeTimers()
    const fetchMock = stubSilentServer()
    const client = createQueryClient()

    const read = client.query({ queryKey: ['x'], queryFn: ({ signal }) => apiGet('/x?q=nom', signal) })
    const failed = expect(read).rejects.toThrow(new RequestTimeoutError('GET /api/x', 30_000))
    await vi.advanceTimersByTimeAsync(30_000)

    await failed
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('tells the person a save had no answer and that the input is kept', async () => {
    vi.useFakeTimers()
    stubSilentServer()

    const save = apiRequest('PUT', '/x', { body: {}, timeoutMs: 30_000 }).catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(30_000)

    expect(prospectRefusal(await save).message).toBe('Pas de réponse après 30 s. Votre saisie est conservée : réessayez.')
  })
})
