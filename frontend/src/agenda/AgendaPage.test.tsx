import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { appointment, sentBodies, stubAgendaApi } from '../test/agendaApi'
import { renderApp } from '../test/render'

// Friday 23 October 2026, 09:00 in Paris.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-23T09:00:00+02:00'))
})
afterEach(() => {
  vi.useRealTimers()
})

const CHIP = /^Rendez-vous 14:30 Jean Exemple · Alpha SARL$/

describe('Agenda page', () => {
  it('is reachable from the navigation', async () => {
    stubAgendaApi()
    renderApp('/agenda')
    expect(await screen.findByRole('heading', { level: 1, name: 'Agenda' })).toBeInTheDocument()
    expect(screen.getAllByRole('link', { name: 'Agenda' })[0]).toHaveAttribute('href', '/agenda')
  })

  it('shows each appointment on its day of the month, Monday first', async () => {
    stubAgendaApi({ items: [appointment()] })
    renderApp('/agenda')

    const day = await screen.findByRole('region', { name: 'lundi 26 octobre 2026' })
    expect(await within(day).findByRole('button', { name: CHIP })).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 2, name: /octobre 2026/i })).toBeInTheDocument()
  })

  it('reminds of tomorrow’s appointments with the last mail the prospect received', async () => {
    stubAgendaApi({
      tomorrow: [
        appointment({
          starts_at: '2026-10-24T10:00:00+02:00',
          ends_at: '2026-10-24T10:30:00+02:00',
          last_mail: {
            step_label: 'Contact',
            subject: 'Votre entité : un échange avec Circoe',
            body_text: 'Bonjour Monsieur Exemple,\n\nJe vous propose un échange de 30 minutes.',
            sent_at: '2026-10-12T08:00:00+02:00',
          },
        }),
      ],
    })
    renderApp('/agenda')

    const reminders = await screen.findByRole('region', { name: 'Rappels' })
    expect(within(reminders).getByRole('heading', { name: /Demain : 1 rendez-vous/ })).toBeInTheDocument()
    expect(within(reminders).getByText('Dernier mail envoyé : Contact, le 12 octobre')).toBeInTheDocument()
    expect(within(reminders).getByText('Votre entité : un échange avec Circoe')).toBeInTheDocument()
    expect(within(reminders).getByText(/Je vous propose un échange de 30 minutes/)).toBeInTheDocument()
  })

  it('records a no-show from the right-click menu', async () => {
    const found = appointment()
    const fetchMock = stubAgendaApi({ items: [found] })
    renderApp('/agenda')

    fireEvent.contextMenu(await screen.findByRole('button', { name: CHIP }))
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Ne s’est pas présenté' }))

    await waitFor(() => {
      expect(sentBodies(fetchMock, 'PATCH', found.id)).toEqual([{ status: 'no_show' }])
    })
  })

  it('moves an appointment: « Décalé… » sends the new start', async () => {
    const found = appointment()
    const fetchMock = stubAgendaApi({ items: [found] })
    renderApp('/agenda')

    fireEvent.contextMenu(await screen.findByRole('button', { name: CHIP }))
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Décalé…' }))
    const dialog = await screen.findByRole('dialog', { name: 'Rendez-vous décalé' })
    fireEvent.change(within(dialog).getByLabelText('Nouvelle date'), { target: { value: '2026-10-28' } })
    fireEvent.change(within(dialog).getByLabelText('Nouvelle heure'), { target: { value: '10:00' } })
    await userEvent.click(within(dialog).getByRole('button', { name: 'Enregistrer le nouveau créneau' }))

    await waitFor(() => {
      expect(sentBodies(fetchMock, 'PATCH', found.id)).toEqual([
        { starts_at: '2026-10-28T09:00:00.000Z', ends_at: '2026-10-28T09:30:00.000Z' },
      ])
    })
  })

  it('opens the detail with the company, the host and the follow-up buttons', async () => {
    stubAgendaApi({ items: [appointment({ prospect: { id: 'p-1', name: 'Jean Exemple' } })] })
    renderApp('/agenda')

    await userEvent.click(await screen.findByRole('button', { name: CHIP }))
    const drawer = await screen.findByRole('dialog', { name: 'Jean Exemple' })
    expect(within(drawer).getByText('Alpha SARL')).toBeInTheDocument()
    expect(within(drawer).getByText('Lucie Jerier')).toBeInTheDocument()
    expect(within(drawer).getByRole('link', { name: 'Jean Exemple' })).toHaveAttribute('href', '/prospection?prospect=p-1')
    expect(within(drawer).getByRole('button', { name: 'Ne s’est pas présenté' })).toBeEnabled()
    expect(within(drawer).queryByRole('button', { name: 'Rétablir' })).not.toBeInTheDocument()
  })

  it('says what the Calendly sync did', async () => {
    stubAgendaApi({
      extra: { 'POST /api/agenda/sync': [200, { ok: true, code: null, created: 2, updated: 1, cancelled: 0 }] },
    })
    renderApp('/agenda')

    await userEvent.click(await screen.findByRole('button', { name: 'Synchroniser avec Calendly' }))

    expect(await screen.findByText('Calendly est à jour : 2 nouveaux, 1 mis à jour, 0 annulé.')).toBeInTheDocument()
  })

  it('points to the connections when Calendly is not linked yet', async () => {
    stubAgendaApi({
      extra: {
        'POST /api/agenda/sync': [200, { ok: false, code: 'calendly_not_configured', created: 0, updated: 0, cancelled: 0 }],
      },
    })
    renderApp('/agenda')

    await userEvent.click(await screen.findByRole('button', { name: 'Synchroniser avec Calendly' }))

    expect(await screen.findByText(/Calendly n’est pas encore relié à VIPER/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Ouvrir les connexions' })).toHaveAttribute('href', '/settings/connections')
  })
})
