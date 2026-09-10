import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import { taxonomyValue } from '../test/settingsApi'
import { lastParams, prospect, stubProspectionApi } from '../test/prospectionApi'
import { renderApp } from '../test/render'
import { type ProspectEditorProps, ProspectEditorContext } from './prospectEditor'

const COUNTERS = '/api/prospection/counters'
const PROSPECTS = '/api/prospection/prospects'
const COMPANY = '00000000-0000-7000-a000-000000000001'

function people() {
  return [
    prospect(
      'Jean',
      'Exemple',
      {
        civility: 'mr',
        role_label: 'Responsable transport',
        exact_job_title: 'Chef de quai fictif',
        company_id: COMPANY,
        company_name: 'Transports Exemple SARL',
        activity_status: 'active',
        employment_verified_at: '2026-09-01T10:00:00+00:00',
        verification_state: 'verified',
        primary_email: 'jean@exemple.example',
        primary_email_status: 'invalid',
        email_state: 'invalid',
        primary_phone: '+33612345678',
        tracking_status: 'to_contact',
        planned_contact_at: '2026-09-07T22:00:00+00:00',
        planned_contact_week: '2026-W37',
        due: true,
        referent_name: 'Camille Référente',
      },
      ['active', 'email_invalid', 'to_contact', 'due'],
    ),
    prospect(
      'Claire',
      'Démo',
      { contactability_status: 'do_not_contact', activity_status: 'inactive', verification_state: 'never_verified' },
      ['inactive', 'do_not_contact', 'never_verified', 'email_missing'],
    ),
    prospect(
      'Luc',
      'Fictif',
      {
        verification_state: 'channels_reset',
        employment_verified_at: '2026-08-01T10:00:00+00:00',
        primary_email: 'luc@demo.example',
        email_state: 'unverified',
        tracking_status: 'follow_up_1',
      },
      ['needs_recheck', 'email_unverified', 'contacted', 'no_response'],
    ),
  ]
}

function list() {
  return screen.getByRole('list', { name: 'Prospects' })
}

function card(name: RegExp) {
  return screen.getByRole('button', { name })
}

describe('Prospection page', () => {
  it('offers the section’s entry points; Add waits for the prospect editor', async () => {
    stubProspectionApi({ prospects: people() })
    renderApp('/prospection')

    expect(screen.getByRole('heading', { level: 1, name: 'Prospection' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Entreprises' })).toHaveAttribute('href', '/prospection/companies')
    expect(screen.getByRole('link', { name: 'Importer Excel' })).toHaveAttribute('href', '/prospection/import')
    // The full-database export of Task 10 (downloads through `ExportWorkbookButton`, tested there).
    expect(screen.getByRole('button', { name: 'Exporter Excel' })).toBeEnabled()
    const add = screen.getByRole('button', { name: 'Ajouter un prospect' })
    expect(add).toHaveAttribute('aria-disabled', 'true')
    expect(add).toHaveAccessibleDescription('Disponible avec l’éditeur de prospect')
    await within(await screen.findByRole('list', { name: 'Prospects' })).findByRole('link', { name: 'Jean Exemple' })
  })

  it('shows every counter and filters the list with a click, in the URL', async () => {
    const api = stubProspectionApi({ prospects: people() })
    const { router } = renderApp('/prospection')

    await waitFor(() => {
      expect(card(/^Tous\s*3/)).toHaveAttribute('aria-pressed', 'true')
    })
    expect(card(/^Échus\s*1/)).toHaveAttribute('aria-pressed', 'false')
    expect(card(/^Opposition\s*1/)).toBeInTheDocument()
    expect(card(/^Sans réponse\s*1/)).toBeInTheDocument()
    expect(within(list()).getAllByRole('listitem')).toHaveLength(3)

    await userEvent.click(card(/^Échus/))

    expect(router.state.location.search).toBe('?segment=due')
    expect(card(/^Échus/)).toHaveAttribute('aria-pressed', 'true')
    expect(within(card(/^Échus/)).getByText('(affiché)')).toBeInTheDocument()
    await waitFor(() => {
      expect(within(list()).getAllByRole('listitem')).toHaveLength(1)
    })
    expect(screen.getByRole('heading', { level: 2, name: /Échus\s*1 prospect/ })).toBeInTheDocument()
    expect(lastParams(api.requests, PROSPECTS).get('segment')).toBe('due')
    // The counters keep counting every segment under the same criteria.
    expect(lastParams(api.requests, COUNTERS).has('segment')).toBe(false)
  })

  it('searches: counters and list follow the same criteria, kept in the URL', async () => {
    const api = stubProspectionApi({ prospects: people() })
    const { router } = renderApp('/prospection?segment=contacted')
    await within(await screen.findByRole('list', { name: 'Prospects' })).findByRole('link', { name: 'Luc Fictif' })

    await userEvent.type(screen.getByRole('searchbox'), 'claire')

    await waitFor(() => {
      expect(router.state.location.search).toBe('?segment=contacted&q=claire')
    })
    await waitFor(() => {
      expect(card(/^Tous\s*1/)).toBeInTheDocument()
    })
    expect(lastParams(api.requests, COUNTERS).get('q')).toBe('claire')
    expect(await screen.findByText('Aucun prospect ne correspond à ces critères.')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Réinitialiser' }))
    expect(router.state.location.search).toBe('')
    expect(screen.getByRole('searchbox')).toHaveValue('')
  })

  it('restores segment, search, filters and page from the URL, and a filter change goes back to page 1', async () => {
    const role = taxonomyValue('Responsable transport')
    const api = stubProspectionApi({ prospects: people(), roles: [role] })
    const { router } = renderApp(`/prospection?segment=no_response&q=luc&activity=unknown&role=${role.id}&page=2`)

    await waitFor(() => {
      expect(lastParams(api.requests, PROSPECTS).get('offset')).toBe('50')
    })
    const sent = lastParams(api.requests, PROSPECTS)
    expect(Object.fromEntries(sent)).toMatchObject({ segment: 'no_response', q: 'luc', activity: 'unknown', role: role.id })
    expect(screen.getByRole('searchbox')).toHaveValue('luc')
    expect(screen.getByRole('combobox', { name: 'Activité' })).toHaveValue('unknown')
    expect(card(/^Sans réponse/)).toHaveAttribute('aria-pressed', 'true')
    await waitFor(() => {
      expect(screen.getByRole('combobox', { name: 'Rôle' })).toHaveValue(role.id)
    })

    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Activité' }), 'Actif')

    const params = new URLSearchParams(router.state.location.search)
    expect(params.get('activity')).toBe('active')
    expect(params.has('page')).toBe(false)
    expect(params.get('segment')).toBe('no_response')
  })

  it('renders each person’s states with text and icons, never colour alone', async () => {
    stubProspectionApi({ prospects: people() })
    renderApp('/prospection')
    const links = await within(await screen.findByRole('list', { name: 'Prospects' })).findAllByRole('link')
    const rows = links.map((link) => link.closest('li') as HTMLElement)
    const [jean, claire, luc] = rows as [HTMLElement, HTMLElement, HTMLElement]

    expect(jean).toHaveTextContent('M.')
    expect(jean).toHaveTextContent('Responsable transport · Chef de quai fictif')
    expect(jean).toHaveTextContent('Transports Exemple SARL')
    expect(jean).toHaveTextContent('+33 6 12 34 56 78')
    expect(within(jean).getByText('Actif')).toBeInTheDocument()
    expect(within(jean).getByText('Vérifié le 1 sept. 2026')).toBeInTheDocument()
    expect(within(jean).getByText('Invalide')).toBeInTheDocument()
    expect(jean).toHaveTextContent('Prévu le 8 sept. 2026')
    expect(within(jean).getByText('S37')).toBeInTheDocument()
    expect(within(jean).getByText('Échu')).toBeInTheDocument()
    expect(jean).toHaveTextContent('Référent : Camille Référente')

    expect(within(claire).getByText('Ne pas contacter')).toBeInTheDocument()
    expect(within(claire).getByText('Inactif')).toBeInTheDocument()
    expect(within(claire).getByText('Emploi jamais vérifié')).toBeInTheDocument()
    expect(within(claire).getByText('Pas d’e-mail principal')).toBeInTheDocument()
    expect(claire).toHaveTextContent('Aucun suivi de contact')
    expect(claire).toHaveTextContent('Rôle non renseigné')

    expect(within(luc).getByText('Coordonnées à revérifier')).toBeInTheDocument()
    expect(within(luc).getByText('Non vérifié')).toBeInTheDocument()
    expect(luc).toHaveTextContent('Relance 1')
    // Every status badge carries a glyph next to its text.
    for (const badge of [jean, claire, luc].flatMap((row) => [...row.querySelectorAll('.badge:not(.badge--tag)')])) {
      expect(badge.querySelector('svg')).not.toBeNull()
      expect(badge.textContent.trim()).not.toBe('')
    }
  })

  it('moves between people with the arrow keys and opens one with Enter (explorer fallback)', async () => {
    const rows = people()
    stubProspectionApi({ prospects: rows })
    const { router } = renderApp('/prospection?segment=all&q=')
    const first = await within(await screen.findByRole('list', { name: 'Prospects' })).findByRole('link', {
      name: 'Jean Exemple',
    })

    act(() => {
      first.focus()
    })
    await userEvent.keyboard('{ArrowDown}')
    expect(screen.getByRole('link', { name: 'Claire Démo' })).toHaveFocus()
    await userEvent.keyboard('{End}')
    expect(screen.getByRole('link', { name: 'Luc Fictif' })).toHaveFocus()
    await userEvent.keyboard('{ArrowUp}{Home}')
    expect(first).toHaveFocus()

    await userEvent.keyboard('{Enter}')

    // Without the Task 15 editor, the person opens in the Database Explorer, replacing the `?prospect=` entry.
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/database/prospects')
    })
    const filters = new URLSearchParams(router.state.location.search).get('filters')
    expect(JSON.parse(filters ?? '[]')).toEqual([{ column: 'id', operator: 'eq', value: rows[0]?.id }])
    expect(screen.getByRole('heading', { level: 1, name: 'Base de données' })).toBeInTheDocument()
  })

  it('hands the prospect, the list queue and navigation to the editor implementation', async () => {
    const rows = people()
    stubProspectionApi({ prospects: rows })
    const opened: ProspectEditorProps[] = []
    function Editor(props: ProspectEditorProps) {
      opened.push(props)
      return (
        <div role="dialog" aria-label={`Éditeur ${props.target}`}>
          <button
            type="button"
            onClick={() => {
              void props.queue.next(props.target).then((step) => {
                props.onNavigate(step?.id ?? null, step ? { page: step.page } : {})
              })
            }}
          >
            Suivant
          </button>
          <button
            type="button"
            onClick={() => {
              props.onNavigate(null)
            }}
          >
            Fermer
          </button>
        </div>
      )
    }
    const { router } = renderApp('/prospection?sort=company', {
      wrap: (app) => <ProspectEditorContext.Provider value={{ canCreate: true, Editor }}>{app}</ProspectEditorContext.Provider>,
    })
    const [jean, claire, luc] = rows.map((row) => row.id)

    await userEvent.click(await screen.findByRole('link', { name: 'Jean Exemple' }))

    expect(new URLSearchParams(router.state.location.search).get('prospect')).toBe(jean)
    expect(new URLSearchParams(router.state.location.search).get('sort')).toBe('company')
    expect(screen.getByRole('dialog', { name: `Éditeur ${String(jean)}` })).toBeInTheDocument()
    const props = opened.at(-1)
    expect(props?.queue.ids).toEqual([jean, claire, luc])
    expect(props?.queue.criteria.sort).toBe('company')
    expect(props?.queue.position(String(claire))).toBe(2)

    await userEvent.click(screen.getByRole('button', { name: 'Suivant' }))
    await waitFor(() => {
      expect(new URLSearchParams(router.state.location.search).get('prospect')).toBe(claire)
    })

    await userEvent.click(screen.getByRole('button', { name: 'Fermer' }))
    expect(router.state.location.search).toBe('?sort=company')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Ajouter un prospect' }))
    expect(new URLSearchParams(router.state.location.search).get('prospect')).toBe('new')
    expect(screen.getByRole('dialog', { name: 'Éditeur new' })).toBeInTheDocument()
  })

  it('invites to import Excel when the base is empty', async () => {
    stubProspectionApi()
    renderApp('/prospection')

    expect(await screen.findByRole('heading', { level: 2, name: 'Aucun prospect pour l’instant' })).toBeInTheDocument()
    expect(screen.getAllByRole('link', { name: 'Importer Excel' })).toHaveLength(2)
    expect(screen.queryByRole('region', { name: 'Compteurs' })).not.toBeInTheDocument()
  })

  it('says when the list cannot be loaded and retries', async () => {
    stubProspectionApi({ prospects: people(), failWith: 500 })
    renderApp('/prospection')

    expect(await screen.findByText('Liste indisponible.')).toBeInTheDocument()
    expect(screen.getByText('Compteurs indisponibles.')).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'Réessayer' })).toHaveLength(2)
  })

  it('explains the verification counters when no age threshold is configured', async () => {
    stubProspectionApi({ prospects: people() })
    renderApp('/prospection')

    expect(await screen.findByText(/Aucun seuil d’ancienneté configuré/)).toBeInTheDocument()
  })
})
