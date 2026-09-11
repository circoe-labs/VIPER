import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import type { Prospect } from '../api/prospects'
import { lastBody, prospectDetail, stubProspectsApi } from '../test/prospectsApi'
import { renderProspectEditor } from '../test/renderProspectEditor'

const OPPOSED: Partial<Prospect> = {
  contactability_status: 'do_not_contact',
  do_not_contact_at: '2026-09-02T08:00:00+00:00',
  do_not_contact_reason: 'Demande de l’intéressé (synthétique)',
}

async function open(detail: Prospect) {
  const api = stubProspectsApi({ details: [detail] })
  const view = renderProspectEditor(detail.id)
  await screen.findByRole('textbox', { name: 'Prénom' })
  return { api, ...view }
}

function opposition() {
  return screen.getByRole('region', { name: 'Opposition' })
}

describe('Prospect editor — opposition and deletion', () => {
  it('records an opposition only with a reason, through its own operation, keeping the form as typed', async () => {
    const { api } = await open(prospectDetail())
    await userEvent.type(screen.getByRole('textbox', { name: 'Nom' }), '-Test')

    await userEvent.click(within(opposition()).getByRole('button', { name: 'Enregistrer une opposition…' }))
    const dialog = screen.getByRole('dialog', { name: 'Enregistrer une opposition ?' })
    expect(within(dialog).getByRole('textbox', { name: /Motif de l’opposition/ })).toHaveFocus()
    expect(dialog).toHaveTextContent('vos autres modifications restent à enregistrer')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Enregistrer l’opposition' }))
    expect(within(dialog).getByText('Indiquez le motif.')).toBeInTheDocument()

    await userEvent.type(within(dialog).getByRole('textbox', { name: /Motif/ }), 'Demande par téléphone')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Enregistrer l’opposition' }))

    expect(await within(opposition()).findByText('Ne pas contacter')).toBeInTheDocument()
    expect(opposition()).toHaveTextContent('Motif : Demande par téléphone')
    expect(lastBody(api.requests, 'PUT')).toEqual({ do_not_contact: true, reason: 'Demande par téléphone', version: 'v1' })
    expect(screen.getByRole('textbox', { name: 'Nom' })).toHaveValue('Exemple-Test')
    expect(screen.getByRole('status')).toHaveTextContent('Modifications non enregistrées')
  })

  it('lifts an opposition with a reason', async () => {
    const { api } = await open(prospectDetail(OPPOSED))
    expect(screen.getByRole('region', { name: 'Suivi de contact' })).toHaveTextContent('ne planifiez pas de contact')

    await userEvent.click(within(opposition()).getByRole('button', { name: 'Lever l’opposition…' }))
    const dialog = screen.getByRole('dialog', { name: 'Lever l’opposition ?' })
    await userEvent.type(within(dialog).getByRole('textbox', { name: /Pourquoi/ }), 'Saisie par erreur')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Lever l’opposition' }))

    expect(await within(opposition()).findByText('Contactable : aucune opposition enregistrée.')).toBeInTheDocument()
    expect(lastBody(api.requests, 'PUT')).toEqual({ do_not_contact: false, reason: 'Saisie par erreur', version: 'v1' })
    expect(screen.getByRole('status')).toHaveTextContent('Opposition levée.')
  })

  it('refuses to delete an opposed prospect, and explains why', async () => {
    await open(prospectDetail(OPPOSED))

    await userEvent.click(screen.getByRole('button', { name: 'Supprimer' }))

    const dialog = screen.getByRole('dialog', { name: 'Suppression impossible' })
    expect(dialog).toHaveTextContent('Levez d’abord l’opposition')
    expect(within(dialog).queryByRole('button', { name: 'Supprimer définitivement' })).not.toBeInTheDocument()
  })

  it('lists what goes with a deleted prospect, then closes the editor', async () => {
    const detail = prospectDetail({
      phones: [
        {
          id: 'p1',
          number: '+33612345678',
          type: 'mobile',
          is_primary: true,
          is_active: true,
          verification_status: 'unverified',
          last_verified_at: null,
          origin_type: 'manual',
          source_reference: null,
          imported_unverified: false,
        },
      ],
      import_row_count: 1,
    })
    const { api, onNavigate } = await open(detail)

    await userEvent.click(screen.getByRole('button', { name: 'Supprimer' }))
    const dialog = screen.getByRole('dialog', { name: 'Supprimer « Jean Exemple » ?' })
    expect(dialog).toHaveTextContent('Seront supprimés avec la fiche : 1 téléphone, 1 ligne d’import d’origine.')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Supprimer définitivement' }))

    expect(await screen.findByText('Éditeur fermé')).toBeInTheDocument()
    expect(onNavigate).toHaveBeenCalledWith(null, undefined)
    expect(api.requests.at(-1)).toMatchObject({ method: 'DELETE', search: '?version=v1' })
  })
})
