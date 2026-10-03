import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import type { EmailAlias, PhoneAlias, Prospect, ProspectInput } from '../api/prospects'
import { company } from '../test/companiesApi'
import { editorReady, editSection, showTab } from '../test/prospectEditorUi'
import { companySummary, lastBody, prospectDetail, stubProspectsApi, trackingDetail } from '../test/prospectsApi'
import { renderProspectEditor } from '../test/renderProspectEditor'
import { taxonomyValue } from '../test/settingsApi'

// The Profil tab as a summary, its read -> edit -> save -> read cycle and the Profil / Suivi tabs (Task 03). The data
// and validations are the editor's own (ProspectEditor.test.tsx, ProspectAliases.test.tsx); here, the views.

const employer = company('Transports Exemple SARL')
const role = taxonomyValue('Responsable transport')

const email: EmailAlias = {
  id: 'e1',
  address: 'jean@exemple.example',
  is_primary: true,
  is_active: true,
  verification_status: 'verified',
  last_verified_at: '2026-06-01T08:00:00+00:00',
  origin_type: 'manual',
  source_reference: null,
  imported_unverified: false,
}

const phone: PhoneAlias = {
  id: 'p1',
  number: '+33612345678',
  type: 'mobile',
  is_primary: true,
  is_active: true,
  verification_status: 'verified',
  last_verified_at: '2026-06-01T08:00:00+00:00',
  origin_type: 'manual',
  source_reference: null,
  imported_unverified: false,
}

function complete(fields: Partial<Prospect> = {}): Prospect {
  return prospectDetail({
    civility: 'mr',
    company: companySummary(employer),
    role: { id: role.id, label: role.label, active: true },
    exact_job_title: 'Chef de quai',
    activity_status: 'active',
    emails: [email],
    phones: [phone],
    ...fields,
  })
}

async function open(detail: Prospect, companies = [employer], roles = [role]) {
  const api = stubProspectsApi({ details: [detail], companies, roles })
  const view = renderProspectEditor(detail.id)
  await editorReady()
  return { api, ...view }
}

const region = (name: string) => screen.getByRole('region', { name })

describe('Prospect editor — Profil summary', () => {
  it('reads a complete profile at a glance: name, role · company, e-mail, phone, tracking state', async () => {
    await open(complete({ tracking: trackingDetail({ status: 'contacted' }) }))

    const summary = region('Résumé du profil')
    expect(summary).toHaveTextContent('M. Jean Exemple')
    await waitFor(() => {
      expect(summary).toHaveTextContent('Responsable transport · Transports Exemple SARL')
    })
    expect(summary).toHaveTextContent('jean@exemple.example')
    expect(summary).toHaveTextContent('+33 6 12 34 56 78')
    expect(summary).toHaveTextContent('Contacté')
    expect(summary).not.toHaveTextContent('Ne pas contacter')
    // Read view: no input anywhere in the Profil sections, every section offers « Modifier ».
    expect(screen.queryByRole('textbox')).toBeNull()
    for (const name of ['Identité', 'E-mails', 'Téléphones', 'Emploi']) {
      expect(within(region(name)).getByRole('button', { name: `Modifier : ${name}` })).toBeInTheDocument()
    }
  })

  it('says so when the e-mail or the phone is missing', async () => {
    await open(complete({ emails: [], phones: [] }))

    const summary = region('Résumé du profil')
    expect(summary).toHaveTextContent('Aucun e-mail')
    expect(summary).toHaveTextContent('Aucun téléphone')
    expect(region('E-mails')).toHaveTextContent('Aucune adresse.')
    expect(region('Téléphones')).toHaveTextContent('Aucun numéro.')
  })

  it('counts the other addresses and ignores inactive ones for the main one', async () => {
    const former = { ...email, id: 'e0', address: 'ancien@exemple.example', is_primary: false, is_active: false }
    const second = { ...email, id: 'e2', address: 'second@exemple.example', is_primary: false }
    await open(complete({ emails: [former, email, second] }))

    const summary = region('Résumé du profil')
    expect(summary).toHaveTextContent('jean@exemple.example +1')
    expect(summary).not.toHaveTextContent('ancien@exemple.example')
    expect(region('E-mails')).toHaveTextContent('ancien@exemple.example')
    expect(region('E-mails')).toHaveTextContent('Ancienne adresse (inactive)')
  })

  it('keeps long names, roles and companies whole, wrapped by the style and readable in full', async () => {
    const longCompany = company(`Société de transports internationaux ${'et de logistique '.repeat(8)}SARL`)
    const longRole = taxonomyValue(`Directeur adjoint des opérations ${'transverses '.repeat(8)}`)
    await open(
      complete({
        first_name: 'Jean-François-Xavier-Marie',
        last_name: 'de la Tour-Maubourg-Montmorency-Beaumont',
        company: companySummary(longCompany),
        role: { id: longRole.id, label: longRole.label, active: true },
        exact_job_title: 'Responsable '.repeat(20),
        emails: [{ ...email, address: `${'prenom.nom.tres.long.'.repeat(5)}@exemple.example` }],
      }),
      [longCompany],
      [longRole],
    )

    const summary = region('Résumé du profil')
    const job = summary.querySelector('.prospect-summary__job')
    await waitFor(() => {
      expect(job).toHaveTextContent(longCompany.display_name)
    })
    expect(job).toHaveTextContent(longRole.label.trim())
    // Nothing is cut in the text; the full reading is also the tooltip.
    expect(job?.getAttribute('title')).toContain(longCompany.display_name)
    expect(summary).toHaveTextContent('de la Tour-Maubourg-Montmorency-Beaumont')
    expect(summary).toHaveTextContent('prenom.nom.tres.long.')
  })

  it('shows the secondary employment verification in Emploi, without a card of its own', async () => {
    await open(complete({ employment_imported_unverified: true }))

    expect(screen.queryByRole('region', { name: 'Vérification de l’emploi' })).toBeNull()
    const verification = within(region('Emploi')).getByRole('group', { name: 'Vérification de l’emploi' })
    expect(verification).toHaveTextContent('Valeurs importées, jamais vérifiées')
    expect(within(verification).getByRole('button', { name: 'Vérifié aujourd’hui' })).toBeInTheDocument()
    // The date input is an edit-mode field.
    expect(within(verification).queryByLabelText('ou vérifié le')).toBeNull()
    await editSection('Emploi')
    expect(within(verification).getByLabelText('ou vérifié le')).toBeInTheDocument()
  })

  it('reserves the score card slot in the right column, empty for now', async () => {
    await open(complete())

    const slot = document.querySelector('[data-slot="prospect-score"]')
    expect(slot).not.toBeNull()
    expect(slot).toBeEmptyDOMElement()
    expect(slot?.closest('.prospect-editor__side')).not.toBeNull()
  })
})

describe('Prospect editor — read, edit, save, read', () => {
  it('edits a section in place, saves with the one request, then reads again with the new values', async () => {
    const { api } = await open(complete())

    await editSection('Identité')
    const first = screen.getByRole('textbox', { name: 'Prénom' })
    // The focus goes into the section (its first control).
    expect(region('Identité')).toContainElement(document.activeElement as HTMLElement)
    await userEvent.clear(first)
    await userEvent.type(first, 'Jeanne')
    // The summary is the same draft: it follows the typing, and the footer says it is not saved.
    expect(region('Résumé du profil')).toHaveTextContent('M. Jeanne Exemple')
    expect(screen.getByRole('status')).toHaveTextContent('Modifications non enregistrées')

    await userEvent.click(screen.getByRole('button', { name: 'Enregistrer' }))
    await screen.findByText('Prospect enregistré.')

    expect((lastBody(api.requests, 'PUT') as ProspectInput).first_name).toBe('Jeanne')
    expect(screen.queryByRole('textbox', { name: 'Prénom' })).toBeNull()
    expect(region('Identité')).toHaveTextContent('Jeanne')
    expect(within(region('Identité')).getByRole('button', { name: 'Modifier : Identité' })).toBeInTheDocument()
  })

  it('« Terminer » goes back to the summary and keeps the change pending in the draft', async () => {
    await open(complete())

    await editSection('Identité')
    await userEvent.type(screen.getByRole('textbox', { name: 'Nom' }), '-Test')
    await userEvent.click(within(region('Identité')).getByRole('button', { name: 'Terminer : Identité' }))

    expect(screen.queryByRole('textbox', { name: 'Nom' })).toBeNull()
    expect(region('Identité')).toHaveTextContent('Exemple-Test')
    expect(screen.getByRole('status')).toHaveTextContent('Modifications non enregistrées')
    expect(within(region('Identité')).getByRole('button', { name: 'Modifier : Identité' })).toHaveFocus()
  })

  it('opens an invalid prospect as inputs where it is invalid, with no way back to the summary', async () => {
    // No company: the Emploi section cannot read as a summary; the valid ones do.
    await open(complete({ company: null }))

    expect(screen.getByRole('combobox', { name: /Entreprise/ })).toBeInTheDocument()
    expect(screen.queryByRole('textbox', { name: 'Prénom' })).toBeNull()
    expect(within(region('Emploi')).queryByRole('button', { name: /Terminer|Modifier/ })).toBeNull()
  })

  it('shows every section as inputs for a new prospect, without summary or switch', () => {
    stubProspectsApi({ companies: [employer] })
    renderProspectEditor('new')

    expect(screen.getByRole('textbox', { name: 'Prénom' })).toHaveFocus()
    expect(screen.getByRole('combobox', { name: /Entreprise/ })).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Résumé du profil' })).toBeNull()
    expect(screen.queryByRole('button', { name: /^Modifier/ })).toBeNull()
  })
})

describe('Prospect editor — Profil and Suivi tabs', () => {
  it('moves between the tabs with the arrow keys, Home and End', async () => {
    await open(complete())
    const profile = screen.getByRole('tab', { name: 'Profil' })
    expect(profile).toHaveAttribute('aria-selected', 'true')
    profile.focus()

    await userEvent.keyboard('{ArrowRight}')
    const tracking = screen.getByRole('tab', { name: 'Suivi' })
    expect(tracking).toHaveAttribute('aria-selected', 'true')
    expect(tracking).toHaveFocus()
    expect(screen.getByRole('tabpanel')).toHaveAccessibleName('Suivi')
    expect(region('Suivi de contact')).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Identité' })).toBeNull()
    for (const name of ['Notes', 'Opposition', 'Provenance']) expect(region(name)).toBeInTheDocument()

    await userEvent.keyboard('{Home}')
    expect(screen.getByRole('tab', { name: 'Profil' })).toHaveAttribute('aria-selected', 'true')
    await userEvent.keyboard('{End}')
    expect(screen.getByRole('tab', { name: 'Suivi' })).toHaveAttribute('aria-selected', 'true')
  })

  it('marks an inactive tab that holds unsaved changes, then clears the mark once saved', async () => {
    await open(complete())
    await showTab('Suivi')
    await userEvent.selectOptions(within(region('Suivi de contact')).getByRole('combobox', { name: 'État' }), 'R1')
    await showTab('Profil')

    expect(screen.getByRole('tab', { name: /^Suivi.*modifications non enregistrées/ })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Profil', selected: true })).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Enregistrer' }))
    await screen.findByText('Prospect enregistré.')
    expect(screen.getByRole('tab', { name: 'Suivi' })).toBeInTheDocument()
  })

  it('brings a refused field of the other tab into view: its tab, then the field with the focus', async () => {
    const { api } = await open(complete({ tracking: trackingDetail({ status: 'contacted' }) }))
    await showTab('Suivi')
    await userEvent.type(within(region('Suivi de contact')).getByLabelText('à'), '10:30')
    await showTab('Profil')

    await userEvent.click(screen.getByRole('button', { name: 'Enregistrer' }))

    const time = await screen.findByLabelText('à')
    expect(screen.getByRole('tab', { name: 'Suivi', selected: true })).toBeInTheDocument()
    expect(time).toHaveFocus()
    expect(time).toHaveAccessibleDescription('Indiquez aussi le jour du rendez-vous.')
    expect(api.requests.filter((request) => request.method === 'PUT')).toEqual([])
  })

  it('flags the tab that still has an error when two tabs have one, and opens the first in edit', async () => {
    await open(complete({ tracking: trackingDetail({ status: 'contacted' }) }))
    await editSection('Identité')
    await userEvent.clear(screen.getByRole('textbox', { name: 'Prénom' }))
    await userEvent.clear(screen.getByRole('textbox', { name: 'Nom' }))
    await showTab('Suivi')
    await userEvent.type(within(region('Suivi de contact')).getByLabelText('à'), '10:30')

    await userEvent.click(screen.getByRole('button', { name: 'Enregistrer' }))

    // The first invalid field (identity) comes first; the other tab carries a mark with its text.
    const last = await screen.findByRole('textbox', { name: 'Nom' })
    expect(last).toHaveFocus()
    expect(screen.getByRole('tab', { name: /^Suivi.*champs à corriger/ })).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('Corrigez les 2 champs signalés.')
    // The section with an error cannot be closed.
    expect(within(region('Identité')).queryByRole('button', { name: 'Terminer : Identité' })).toBeNull()
  })
})
