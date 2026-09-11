import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import type { Prospect, ProspectInput } from '../api/prospects'
import { company } from '../test/companiesApi'
import { companySummary, lastBody, prospectDetail, stubProspectsApi } from '../test/prospectsApi'
import { renderProspectEditor } from '../test/renderProspectEditor'
import { taxonomyValue } from '../test/settingsApi'

const employer = company('Transports Exemple SARL', { email_domain: 'exemple.example' })
const role = taxonomyValue('Responsable transport')

function imported(fields: Partial<Prospect> = {}): Prospect {
  return prospectDetail({
    civility: 'mr',
    first_name: 'Jean',
    last_name: 'Import',
    company: companySummary(employer),
    role: { id: role.id, label: role.label, active: true },
    exact_job_title: 'Chef de quai fictif',
    activity_status: 'active',
    employment_imported_unverified: true,
    emails: [
      {
        id: 'e1',
        address: 'jean@exemple.example',
        is_primary: true,
        is_active: true,
        verification_status: 'unverified',
        last_verified_at: null,
        origin_type: 'imported',
        source_reference: 'base.xlsx / Prospects / ligne 7',
        imported_unverified: true,
      },
    ],
    sources: [
      {
        id: 's1',
        source_type: 'excel_import',
        source_reference: 'base.xlsx / Prospects / ligne 7',
        collected_at: '2026-09-01T08:00:00+00:00',
        legal_basis_or_collection_context: 'Fichier historique (synthétique)',
        actor_display: 'Import base.xlsx',
        import_filename: 'base.xlsx',
      },
    ],
    ...fields,
  })
}

function region(name: string | RegExp) {
  return screen.getByRole('region', { name })
}

async function open(detail: Prospect) {
  const api = stubProspectsApi({ details: [detail], companies: [employer], roles: [role] })
  const view = renderProspectEditor(detail.id)
  await screen.findByRole('textbox', { name: 'Prénom' })
  return { api, ...view }
}

describe('Prospect editor', () => {
  it('opens the person prefilled, section by section', async () => {
    await open(imported())

    const dialog = screen.getByRole('dialog', { name: 'M. Jean Import' })
    expect(dialog).toHaveAccessibleDescription('Prospect 1 sur 1 · Jamais vérifiés')
    expect(screen.getByRole('textbox', { name: 'Nom' })).toHaveValue('Import')
    expect(screen.getByRole('textbox', { name: 'Intitulé exact' })).toHaveValue('Chef de quai fictif')
    expect(screen.getByRole('radio', { name: 'Actif' })).toBeChecked()
    expect(within(region('E-mails')).getByRole('textbox', { name: 'Adresse e-mail' })).toHaveValue('jean@exemple.example')
    await waitFor(() => {
      expect(screen.getByRole('combobox', { name: /Entreprise/ })).toHaveValue('Transports Exemple SARL')
    })
    await waitFor(() => {
      expect(screen.getByRole('combobox', { name: 'Rôle' })).toHaveValue('Responsable transport')
    })
    expect(region('Provenance')).toHaveTextContent('Import Excel · base.xlsx / Prospects / ligne 7')
    expect(within(region('Entreprise')).getByRole('button', { name: 'Ouvrir la fiche entreprise' })).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('Ctrl+S enregistrer')
  })

  it('shows imported values never verified in warning style, with text and glyph', async () => {
    await open(imported())

    const verification = region('Vérification de l’emploi')
    const badge = within(verification).getByText('Valeurs importées, jamais vérifiées')
    expect(badge.closest('.badge')?.querySelector('svg')).not.toBeNull()
    expect(screen.getByRole('textbox', { name: 'Intitulé exact' })).toHaveAccessibleDescription(
      /Valeur importée, jamais vérifiée : confirmez-la\./,
    )
    expect(region('E-mails')).toHaveTextContent('1 à vérifier')
    expect(region('E-mails')).toHaveTextContent('Importé, jamais vérifié')

    await userEvent.click(within(verification).getByRole('button', { name: 'Vérifié aujourd’hui' }))

    expect(verification).toHaveTextContent('Vérifié aujourd’hui — à enregistrer')
    expect(screen.getByRole('textbox', { name: 'Intitulé exact' })).not.toHaveAccessibleDescription(/importée/)
    expect(screen.getByRole('status')).toHaveTextContent('Modifications non enregistrées')
  })

  it('marks a recent verification with a subtle positive state and its date', async () => {
    await open(
      imported({
        employment_imported_unverified: false,
        verification_state: 'verified',
        employment_verified_at: '2026-09-03T08:00:00+00:00',
      }),
    )

    expect(region('Vérification de l’emploi')).toHaveTextContent('Vérifié le 3 sept. 2026')
    expect(screen.getByRole('textbox', { name: 'Intitulé exact' })).not.toHaveAccessibleDescription(/importée/)
  })

  it('saves the whole form in one request, then refreshes the Prospection list', async () => {
    const { api, queryClient } = await open(imported())
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')

    await userEvent.type(screen.getByRole('textbox', { name: 'Prénom' }), 'ne')
    await userEvent.click(within(region('E-mails')).getByRole('button', { name: 'Vérifié' }))
    await userEvent.click(screen.getByRole('button', { name: 'Enregistrer' }))

    expect(await screen.findByText('Prospect enregistré.')).toBeInTheDocument()
    const body = lastBody(api.requests, 'PUT') as ProspectInput & { version: string }
    expect(body).toMatchObject({ version: 'v1', first_name: 'Jeanne', employment_verification: { action: 'keep', day: null } })
    expect(body.emails[0]).toMatchObject({ id: 'e1', verified_now: true, verification_status: 'verified' })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['prospection'] })
    expect(region('E-mails')).toHaveTextContent('Vérifié le 11 sept. 2026')
  })

  it('keeps a dirty-state bar: revert, and closing asks first', async () => {
    const { onNavigate } = await open(imported())
    const name = screen.getByRole('textbox', { name: 'Nom' })

    await userEvent.type(name, 'x')
    await userEvent.click(screen.getByRole('button', { name: 'Annuler les modifications' }))
    expect(name).toHaveValue('Import')

    await userEvent.type(name, 'x')
    await userEvent.keyboard('{Escape}')
    const confirm = screen.getByRole('dialog', { name: 'Abandonner les modifications ?' })
    await userEvent.click(within(confirm).getByRole('button', { name: 'Fermer sans enregistrer' }))
    expect(onNavigate).toHaveBeenCalledWith(null, undefined)
  })

  it('places server refusals on their field and offers to reload after a conflict', async () => {
    const { api } = await open(imported())
    api.next.reply = [422, { code: 'invalid', field: 'emails.0.address', reason: 'format', message: 'Invalid.' }]

    await userEvent.type(screen.getByRole('textbox', { name: 'Prénom' }), 'ne')
    await userEvent.keyboard('{Control>}s{/Control}')

    const address = within(region('E-mails')).getByRole('textbox', { name: 'Adresse e-mail' })
    await waitFor(() => {
      expect(address).toHaveAccessibleDescription(/Adresse e-mail invalide/)
    })
    expect(address).toHaveFocus()

    api.next.reply = [409, { code: 'conflict', message: 'Changed.' }]
    await userEvent.keyboard('{Control>}s{/Control}')
    expect(await screen.findByText(/Ce prospect a été modifié ailleurs/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Recharger la fiche' }))
    await waitFor(() => {
      expect(screen.getByRole('textbox', { name: 'Prénom' })).toHaveValue('Jean')
    })
  })
})
