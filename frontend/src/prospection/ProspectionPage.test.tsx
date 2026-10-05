import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import { taxonomyValue } from '../test/settingsApi'
import { lastParams, prospect, stubProspectionApi } from '../test/prospectionApi'
import { prospectDetail, stubProspectsApi } from '../test/prospectsApi'
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
        tracking_status: 'neutral',
        planned_contact_at: '2026-09-06T22:00:00+00:00',
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
        tracking_status: 'r1',
        planned_contact_at: '2027-01-03T23:00:00+00:00',
        planned_contact_week: '2027-W01',
      },
      ['needs_recheck', 'email_unverified', 'contacted', 'no_response'],
    ),
  ]
}

function list() {
  return screen.getByRole('list', { name: 'Prospects' })
}

function panel(name: RegExp) {
  return screen.getByRole('button', { name })
}

describe('Prospection page', () => {
  it('offers the section’s entry points; Add opens the prospect editor on a new person', async () => {
    stubProspectionApi({ prospects: people() })
    const { router } = renderApp('/prospection')

    expect(screen.getByRole('heading', { level: 1, name: 'Prospection' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Entreprises' })).toHaveAttribute('href', '/prospection/companies')
    expect(screen.getByRole('link', { name: 'Importer Excel' })).toHaveAttribute('href', '/prospection/import')
    // The full-database export of Task 10 (downloads through `ExportWorkbookButton`, tested there).
    expect(screen.getByRole('button', { name: 'Exporter Excel' })).toBeEnabled()
    await within(await screen.findByRole('list', { name: 'Prospects' })).findByRole('link', { name: 'Jean Exemple' })
    const add = screen.getByRole('button', { name: 'Ajouter un prospect' })
    expect(add).not.toHaveAttribute('aria-disabled', 'true')

    await userEvent.click(add)

    expect(new URLSearchParams(router.state.location.search).get('prospect')).toBe('new')
    expect(await screen.findByRole('dialog', { name: 'Nouveau prospect' })).toBeInTheDocument()
  })

  it('shows the three panels with their week figures and filters the list with a click, in the URL', async () => {
    const api = stubProspectionApi({
      prospects: [
        prospect('Vera', 'Verifiee', { review: 'verified', verification_state: 'verified', email_state: 'verified' }, [], true),
        prospect('Victor', 'Verifie', { review: 'verified', verification_state: 'verified', email_state: 'verified' }),
        prospect('Alix', 'Averifier', {}, [], true),
        prospect('Igor', 'Ignore', { review: 'ignored', tracking_status: 'ignored' }),
      ],
    })
    const { router } = renderApp('/prospection')

    // « 2 dont +1 cette semaine »: the size and what arrived since Monday.
    await waitFor(() => {
      expect(panel(/^Vérifiés : 2, dont 1 cette semaine/)).toBeInTheDocument()
    })
    expect(panel(/^À vérifier : 1, dont 1 cette semaine/)).toHaveAttribute('aria-pressed', 'false')
    expect(panel(/^Ignorés : 1, dont 0 cette semaine/)).toBeInTheDocument()
    expect(screen.getByText(/Semaine 37/)).toBeInTheDocument()
    expect(within(list()).getAllByRole('listitem')).toHaveLength(4)

    await userEvent.click(panel(/^Vérifiés/))

    expect(router.state.location.search).toBe('?review=verified')
    expect(panel(/^Vérifiés/)).toHaveAttribute('aria-pressed', 'true')
    await waitFor(() => {
      expect(within(list()).getAllByRole('listitem')).toHaveLength(2)
    })
    expect(screen.getByRole('heading', { level: 2, name: /Prospects vérifiés\s*2 prospects/ })).toBeInTheDocument()
    expect(lastParams(api.requests, PROSPECTS).get('review')).toBe('verified')
    // The panels keep counting every review under the same criteria.
    expect(lastParams(api.requests, COUNTERS).has('review')).toBe(false)

    // Pressed again: everyone.
    await userEvent.click(panel(/^Vérifiés/))
    expect(router.state.location.search).toBe('')
  })

  it('still opens a segment linked from Home, and a panel replaces it', async () => {
    const api = stubProspectionApi({ prospects: people() })
    const { router } = renderApp('/prospection?segment=due')

    expect(await screen.findByRole('heading', { level: 2, name: /Échus\s*1 prospect/ })).toBeInTheDocument()
    expect(lastParams(api.requests, PROSPECTS).get('segment')).toBe('due')

    await userEvent.click(panel(/^À vérifier/))

    expect(router.state.location.search).toBe('?review=to_verify')
  })

  it('searches: panels and list follow the same criteria, kept in the URL', async () => {
    const api = stubProspectionApi({ prospects: people() })
    const { router } = renderApp('/prospection?review=to_verify')
    await within(await screen.findByRole('list', { name: 'Prospects' })).findByRole('link', { name: 'Luc Fictif' })

    await userEvent.type(screen.getByRole('searchbox'), 'zzz')

    await waitFor(() => {
      expect(router.state.location.search).toBe('?review=to_verify&q=zzz')
    })
    await waitFor(() => {
      expect(panel(/^À vérifier : 0/)).toBeInTheDocument()
    })
    expect(lastParams(api.requests, COUNTERS).get('q')).toBe('zzz')
    expect(await screen.findByText('Aucun prospect ne correspond à ces critères.')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Réinitialiser' }))
    expect(router.state.location.search).toBe('')
    expect(screen.getByRole('searchbox')).toHaveValue('')
  })

  it('restores panel, search, filters and page from the URL, and a filter change goes back to page 1', async () => {
    const role = taxonomyValue('Responsable transport')
    const api = stubProspectionApi({ prospects: people(), roles: [role] })
    const { router } = renderApp(`/prospection?review=to_verify&q=luc&activity=unknown&role=${role.id}&page=2`)

    await waitFor(() => {
      expect(lastParams(api.requests, PROSPECTS).get('offset')).toBe('50')
    })
    const sent = lastParams(api.requests, PROSPECTS)
    expect(Object.fromEntries(sent)).toMatchObject({ review: 'to_verify', q: 'luc', activity: 'unknown', role: role.id })
    expect(screen.getByRole('searchbox')).toHaveValue('luc')
    expect(screen.getByRole('combobox', { name: 'Activité' })).toHaveValue('unknown')
    expect(panel(/^À vérifier/)).toHaveAttribute('aria-pressed', 'true')
    await waitFor(() => {
      expect(screen.getByRole('combobox', { name: 'Rôle' })).toHaveValue(role.id)
    })

    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Activité' }), 'Actif')

    const params = new URLSearchParams(router.state.location.search)
    expect(params.get('activity')).toBe('active')
    expect(params.has('page')).toBe(false)
    expect(params.get('review')).toBe('to_verify')
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
    // One review line per person, with its reason; the address is plain text and its state a dot (read out too).
    expect(within(jean).getByText('E-mail invalide')).toBeInTheDocument()
    expect(within(jean).getByText('jean@exemple.example')).toBeInTheDocument()
    expect(within(jean).getByText('Adresse invalide')).toBeInTheDocument()
    // Neutral with a week: the week badge only, no state badge (Contact decisions 4-5).
    expect(within(jean).getByText('S37')).toBeInTheDocument()
    expect(within(jean).getByTitle('Semaine 37 de 2026, du lun. 7 sept.')).toBeInTheDocument()
    expect(jean.textContent).not.toMatch(/État :|À contacter|Aucun état/)
    expect(within(jean).getByText('Échu')).toBeInTheDocument()
    expect(jean).toHaveTextContent('Référent : Camille Référente')

    expect(within(claire).getByText('Ne pas contacter')).toBeInTheDocument()
    expect(claire).toHaveTextContent('Plus en poste')
    expect(within(claire).getByText('Emploi jamais vérifié')).toBeInTheDocument()
    expect(within(claire).getByText('Pas d’e-mail principal')).toBeInTheDocument()
    expect(claire.textContent).not.toMatch(/Aucun état|aucune semaine/)
    expect(claire).toHaveTextContent('Rôle non renseigné')

    expect(within(luc).getByText('Coordonnées à revérifier')).toBeInTheDocument()
    expect(within(luc).getByText('Adresse non vérifiée')).toBeInTheDocument()
    // A state and a week of another year: both badges, the year written out.
    expect(within(luc).getByText('R1')).toBeInTheDocument()
    expect(within(luc).getByText('S01 · 2027')).toBeInTheDocument()
    // Every status badge carries a glyph next to its text.
    for (const badge of [jean, claire, luc].flatMap((row) => [...row.querySelectorAll('.badge:not(.badge--tag)')])) {
      expect(badge.querySelector('svg')).not.toBeNull()
      expect(badge.textContent.trim()).not.toBe('')
    }
  })

  it('flags a past next-action week of a follow-up as « Échu », display only', async () => {
    // The fake's business day is 2026-09-10 (week 37).
    stubProspectionApi({
      prospects: [
        prospect('Rémi', 'Retard', { tracking_status: 'r2', planned_contact_week: '2026-W30' }),
        prospect('Alice', 'Alheure', { tracking_status: 'contacted', planned_contact_week: '2026-W38' }),
        prospect('Fanny', 'Fermée', { tracking_status: 'failure', planned_contact_week: '2026-W30' }),
      ],
    })
    renderApp('/prospection?segment=all&q=')
    const rows = within(await screen.findByRole('list', { name: 'Prospects' })).getAllByRole('listitem')

    expect(rows[0]).toHaveTextContent('Échu')
    expect(rows[1]).not.toHaveTextContent('Échu')
    // Failure has no next action: its old week is not overdue.
    expect(rows[2]).not.toHaveTextContent('Échu')
  })

  it('offers « Aucun état » as one state filter, covering people without any tracking', async () => {
    const api = stubProspectionApi({ prospects: people() })
    renderApp('/prospection?segment=all&q=')
    await userEvent.click(await screen.findByRole('button', { name: /^Filtres/ }))
    const filter = screen.getByRole('combobox', { name: 'État de contact' })
    expect(within(filter).getAllByRole('option').map((option) => option.textContent)).toEqual([
      'Tous les états',
      'Aucun état',
      'Contacté',
      'R1',
      'R2',
      'Réponse reçue',
      'RDV pris',
      'Failure',
      'Ignoré',
    ])
    await userEvent.selectOptions(filter, 'Aucun état')
    await waitFor(() => {
      expect(lastParams(api.requests, PROSPECTS).get('tracking_status')).toBe('neutral')
    })
  })

  it('moves between people with the arrow keys and opens one with Enter in the prospect editor', async () => {
    const rows = people()
    stubProspectsApi({ rows, details: rows.map((row) => prospectDetail({ id: row.id, first_name: row.first_name, last_name: row.last_name })) })
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

    // The editor opens over the list, which keeps its criteria behind it (`?prospect=` pushed).
    expect(await screen.findByRole('dialog', { name: 'Jean Exemple' })).toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/prospection')
    expect(new URLSearchParams(router.state.location.search).get('prospect')).toBe(rows[0]?.id)
    expect(screen.getByRole('heading', { level: 1, name: 'Prospection' })).toBeInTheDocument()
  })

  it('plans a week from the list without touching the state (PATCH), and says why a save is refused', async () => {
    const rows = [
      ...people(),
      prospect('Ida', 'Ignorée', { tracking_status: 'ignored', contactability_status: 'do_not_contact' }),
    ]
    const api = stubProspectsApi({
      rows,
      details: rows.map((row) => prospectDetail({ id: row.id, first_name: row.first_name, last_name: row.last_name })),
    })
    renderApp('/prospection?segment=all&q=')
    const prospects = await screen.findByRole('list', { name: 'Prospects' })
    await within(prospects).findByRole('link', { name: 'Luc Fictif' })
    // « Ignoré » has no next action: nothing to plan.
    expect(within(prospects).queryByRole('button', { name: /la semaine de Ida Ignorée/ })).toBeNull()

    await userEvent.click(within(prospects).getByRole('button', { name: 'Planifier la semaine de Claire Démo' }))
    const popover = await screen.findByRole('dialog', { name: 'Prochaine semaine de Claire Démo' })
    // Once the prospect is read, its first control has the focus.
    await waitFor(() => {
      expect(within(popover).getByRole('combobox', { name: 'Année' })).toHaveFocus()
    })
    await userEvent.click(await within(popover).findByRole('button', { name: '+2 semaines' }))
    await userEvent.click(within(popover).getByRole('button', { name: 'Enregistrer S39' }))

    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Prochaine semaine de Claire Démo' })).toBeNull()
    })
    const patch = api.requests.find((request) => request.method === 'PATCH')
    expect(patch?.path).toBe(`/api/prospects/${rows[1]?.id ?? ''}/tracking`)
    // The week only: no `status`, so the person stays neutral (handoff Task 06).
    expect(patch?.body).toEqual({ version: 'v1', next_action_week: { year: 2026, week: 39 } })
    expect(await screen.findByText('Semaine S39 enregistrée.')).toBeInTheDocument()

    await userEvent.click(within(prospects).getByRole('button', { name: 'Replanifier la semaine de Luc Fictif' }))
    const again = await screen.findByRole('dialog', { name: 'Prochaine semaine de Luc Fictif' })
    await userEvent.click(await within(again).findByRole('button', { name: 'Cette semaine' }))
    api.next.reply = [409, { code: 'ignored_has_no_next_action', message: 'An ignored prospect has no next action.' }]
    await userEvent.click(within(again).getByRole('button', { name: 'Enregistrer S37' }))
    expect(await within(again).findByRole('alert')).toHaveTextContent(
      'Un prospect « Ignoré » n’a pas de prochaine action : effacez la semaine.',
    )
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
    expect(screen.queryByRole('region', { name: 'Vérification de la base' })).not.toBeInTheDocument()
  })

  it('says when the list cannot be loaded and retries', async () => {
    stubProspectionApi({ prospects: people(), failWith: 500 })
    renderApp('/prospection')

    expect(await screen.findByText('Liste indisponible.')).toBeInTheDocument()
    expect(screen.getByText('Compteurs indisponibles.')).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'Réessayer' })).toHaveLength(2)
  })
})
