import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import { cohort, S0, taxonomyValue } from '../test/settingsApi'
import { lastParams, prospect, stubProspectionApi } from '../test/prospectionApi'
import { prospectDetail, stubProspectsApi } from '../test/prospectsApi'
import { renderApp } from '../test/render'
import { type ProspectEditorProps, ProspectEditorContext } from './prospectEditor'

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
        cohort_code: 'S37',
        level: 'contact_pending',
        next_step: 'contact',
        next_due_at: '2026-09-06T22:00:00+00:00',
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
        tracking_status: 'neutral',
        cohort_code: 'S36',
        sent_count: 2,
        level: 'r1_sent',
        next_step: 'r2',
        next_due_at: '2026-09-13T22:00:00+00:00',
      },
      ['needs_recheck', 'email_unverified', 'contacted', 'no_response'],
    ),
  ]
}

function list() {
  return screen.getByRole('list', { name: 'Prospects' })
}

// « Filtres » is a menu (details/summary): open it, then use its quick filters and fields.
async function openFilters() {
  await userEvent.click(screen.getByText('Filtres', { selector: 'summary' }))
}

function chips() {
  return within(screen.getByRole('group', { name: 'Filtres appliqués' }))
}

describe('Prospection page', () => {
  it('shows the entity selector as three KPI cards with totals; each entity is a URL and Back returns to the previous one', async () => {
    stubProspectionApi({ prospects: people(), warehouseContacts: 2 })
    const { router } = renderApp('/prospection')
    const nav = await screen.findByRole('navigation', { name: 'Type de fiche' })
    expect(within(nav).getByRole('link', { name: /^Prospects/ })).toHaveAttribute('aria-current', 'page')
    expect(within(nav).getByRole('link', { name: /^Entreprises/ })).toHaveAttribute('href', '/prospection?entity=company')
    expect(within(nav).getByRole('link', { name: /^Entrepôts/ })).toHaveAttribute('href', '/prospection?entity=warehouse')
    await waitFor(() => { expect(within(nav).getByRole('link', { name: /^Prospects\s*3/ })).toBeInTheDocument() })

    await userEvent.click(within(nav).getByRole('link', { name: /^Entreprises/ }))
    expect(router.state.location.search).toBe('?entity=company')
    expect(await screen.findByRole('searchbox', { name: /Rechercher une entreprise/ })).toBeVisible()
    expect(screen.queryByRole('list', { name: 'Prospects' })).not.toBeInTheDocument()

    await userEvent.click(within(nav).getByRole('link', { name: /^Entrepôts/ }))
    expect(router.state.location.search).toBe('?entity=warehouse')
    expect(await screen.findByRole('searchbox', { name: /Rechercher un entrepôt/ })).toBeVisible()
    await openFilters()
    await userEvent.click(within(screen.getByRole('group', { name: 'Filtres rapides' })).getByRole('button', { name: 'À contacter' }))
    expect(router.state.location.search).toBe('?entity=warehouse&warehouse_to_contact=true')

    await act(async () => { await router.navigate(-2) })
    expect(await screen.findByRole('list', { name: 'Prospects' })).toBeVisible()
  })

  it('shows the weekly delta chip only when the source has the figure, « — » otherwise', async () => {
    stubProspectionApi({ prospects: people() })
    renderApp('/prospection')
    const nav = await screen.findByRole('navigation', { name: 'Type de fiche' })
    await waitFor(() => { expect(within(nav).getByRole('link', { name: /^Prospects/ })).toHaveTextContent('—') })
    expect(screen.queryByText(/cette semaine/)).not.toBeInTheDocument()
  })

  it.each(['/prospection', '/prospection?list=1', '/prospection?review=incomplete'])('shows the table directly, with no section to unfold, at %s', async (url) => {
    stubProspectionApi({ prospects: people() })
    renderApp(url)
    expect(await screen.findByRole('list', { name: 'Prospects' })).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Afficher la liste' })).not.toBeInTheDocument()
    expect(document.querySelector('details.prospection-exploration')).toBeNull()
  })
  it('quick filters of Prospects restrict the list in the same layout; chips show, remove and clear them', async () => {
    const api = stubProspectionApi({ prospects: [
      prospect('Alice', 'PME', { company_kind: 'sme' }),
      prospect('Bob', 'Institution', { company_kind: 'institutional' }),
    ] })
    const { router } = renderApp('/prospection?page=2&company_kind=sme')
    expect(await screen.findByText('Type : PME')).toBeVisible()
    await userEvent.click(screen.getByRole('button', { name: 'Retirer le filtre : Type : PME' }))
    expect(router.state.location.search).toBe('')
    await waitFor(() => { expect(within(list()).getAllByRole('listitem')).toHaveLength(2) })
    expect(chips().getByText('Aucun filtre')).toBeVisible()
    expect(lastParams(api.requests, PROSPECTS).has('company_kind')).toBe(false)
  })

  it('offers the section’s entry points; Add opens the prospect editor on a new person', async () => {
    stubProspectionApi({ prospects: people() })
    const { router } = renderApp('/prospection')

    expect(screen.getByRole('heading', { level: 1, name: 'Prospection' })).toBeInTheDocument()
    await userEvent.click(screen.getByText('Autres actions'))
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

  it('« Emploi validé » is a plain restriction of the prospects list: same layout, a removable chip, no other entity', async () => {
    const api = stubProspectionApi({
      prospects: [
        prospect('Vera', 'Verifiee', { employment_verified_at: '2026-09-01T10:00:00Z', review: 'verified', verification_state: 'verified', email_state: 'verified' }),
        prospect('Victor', 'Verifie', { employment_verified_at: '2026-09-01T10:00:00Z', review: 'incomplete', verification_state: 'verified', email_state: 'unverified' }),
        prospect('Alix', 'Averifier', {}, [], true),
        prospect('Igor', 'Ignore', { review: 'ignored', tracking_status: 'ignored' }),
      ],
    })
    const { router } = renderApp('/prospection')
    // The ignored are hidden by default.
    await waitFor(() => { expect(within(list()).getAllByRole('listitem')).toHaveLength(3) })
    expect(within(list()).queryByText(/Igor/)).not.toBeInTheDocument()
    expect(chips().getByText('Aucun filtre')).toBeVisible()

    await openFilters()
    const quick = within(screen.getByRole('group', { name: 'Statut du prospect' }))
    expect(quick.getAllByRole('button').map((button) => button.textContent)).toEqual(['Vérifié', 'Exploitable', 'Incomplet', 'Ignoré'])
    await userEvent.click(quick.getByRole('button', { name: 'Vérifié' }))

    expect(router.state.location.search).toBe('?review=verified')
    // Same list layout (no reachable-prospects table), same entity.
    await waitFor(() => { expect(within(list()).getAllByRole('listitem')).toHaveLength(1) })
    expect(screen.queryByRole('table', { name: 'Prospects' })).not.toBeInTheDocument()
    expect(within(list()).queryByText(/Alix/)).not.toBeInTheDocument()
    expect(chips().getByText('Vérifié')).toBeVisible()
    expect(lastParams(api.requests, PROSPECTS).get('review')).toBe('verified')

    // Several statuses can be chosen at once (any of them); « Tout effacer » removes every chip.
    await userEvent.click(quick.getByRole('button', { name: 'Ignoré' }))
    expect(router.state.location.search).toBe('?review=ignored&review=verified')
    expect(lastParams(api.requests, PROSPECTS).getAll('review')).toEqual(['verified', 'ignored'])
    await userEvent.click(quick.getByRole('button', { name: 'Vérifié' }))
    expect(router.state.location.search).toBe('?review=ignored')
    await userEvent.click(chips().getByRole('button', { name: 'Tout effacer' }))
    expect(router.state.location.search).toBe('')
    expect(chips().getByText('Aucun filtre')).toBeVisible()
  })

  it('drops the filters of the old entity on switch: validated_only does not survive on Entreprises, q does', async () => {
    stubProspectionApi({ prospects: people() })
    const { router } = renderApp('/prospection?validated_only=true&q=abc&sort=updated&created_from=2026-11-02')
    const nav = await screen.findByRole('navigation', { name: 'Type de fiche' })
    await userEvent.click(within(nav).getByRole('link', { name: /^Entreprises/ }))
    const params = new URLSearchParams(router.state.location.search)
    expect(Object.fromEntries(params)).toEqual({ entity: 'company', q: 'abc', sort: 'updated', created_from: '2026-11-02' })
    expect(chips().queryByText('Emploi validé')).not.toBeInTheDocument()
    await userEvent.click(within(nav).getByRole('link', { name: /^Entrepôts/ }))
    expect(Object.fromEntries(new URLSearchParams(router.state.location.search))).toEqual({ entity: 'warehouse', q: 'abc', sort: 'updated' })
  })

  it('sorts through the sort param; companies and warehouses send it to their API', async () => {
    const api = stubProspectionApi({ prospects: people() })
    const { router } = renderApp('/prospection?entity=company')
    await userEvent.selectOptions(await screen.findByRole('combobox', { name: 'Trier par' }), 'Date d’ajout')
    expect(router.state.location.search).toBe('?entity=company&sort=created')
    await waitFor(() => { expect(api.fetchMock.mock.calls.some(([url]) => String(url).startsWith('/api/companies?') && String(url).includes('sort=created'))).toBe(true) })
  })

  it('still opens a segment linked from Home, as a chip, and a quick filter replaces it', async () => {
    const api = stubProspectionApi({ prospects: people() })
    const { router } = renderApp('/prospection?segment=due')

    expect(await chips().findByText('Échus')).toBeVisible()
    expect(lastParams(api.requests, PROSPECTS).get('segment')).toBe('due')

    await openFilters()
    await userEvent.click(within(screen.getByRole('group', { name: 'Statut du prospect' })).getByRole('button', { name: 'Incomplet' }))

    expect(Object.fromEntries(new URLSearchParams(router.state.location.search))).toEqual({ segment: 'due', review: 'incomplete' })
  })

  it('searches: chips and list follow the same criteria, kept in the URL', async () => {
    const api = stubProspectionApi({ prospects: people() })
    const { router } = renderApp('/prospection?review=incomplete')
    await within(await screen.findByRole('list', { name: 'Prospects' })).findByRole('link', { name: 'Luc Fictif' })

    await userEvent.type(screen.getByRole('searchbox'), 'zzz')

    await waitFor(() => {
      expect(router.state.location.search).toBe('?review=incomplete&q=zzz')
    })
    await waitFor(() => { expect(lastParams(api.requests, PROSPECTS).get('q')).toBe('zzz') })
    expect(await screen.findByText('Aucun prospect ne correspond à ces critères.')).toBeInTheDocument()

    await userEvent.click(chips().getByRole('button', { name: 'Tout effacer' }))
    expect(router.state.location.search).toBe('?q=zzz')
  })

  it('restores search, filters and page from the URL, and a filter change goes back to page 1', async () => {
    const role = taxonomyValue('Responsable transport')
    const api = stubProspectionApi({ prospects: people(), roles: [role] })
    const { router } = renderApp(`/prospection?review=incomplete&q=luc&activity=unknown&role=${role.id}&page=2`)

    await waitFor(() => {
      expect(lastParams(api.requests, PROSPECTS).get('offset')).toBe('50')
    })
    const sent = lastParams(api.requests, PROSPECTS)
    expect(Object.fromEntries(sent)).toMatchObject({ review: 'incomplete', q: 'luc', activity: 'unknown', role: role.id })
    expect(screen.getByRole('searchbox')).toHaveValue('luc')
    expect(await chips().findByText('Activité : Activité inconnue')).toBeVisible()
    expect(await chips().findByText('Rôle : Responsable transport')).toBeVisible()
    await openFilters()
    expect(screen.getByRole('combobox', { name: 'Activité' })).toHaveValue('unknown')
    await waitFor(() => {
      expect(screen.getByRole('combobox', { name: 'Rôle' })).toHaveValue(role.id)
    })

    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Activité' }), 'Actif')

    const params = new URLSearchParams(router.state.location.search)
    expect(params.get('activity')).toBe('active')
    expect(params.has('page')).toBe(false)
    expect(params.get('review')).toBe('incomplete')
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
    expect(within(jean).getByText(/e-mail invalide/)).toBeInTheDocument()
    expect(within(jean).getByText('jean@exemple.example')).toBeInTheDocument()
    expect(within(jean).getByText('Adresse invalide')).toBeInTheDocument()
    // « En séquence »: the cohort and the level, no state badge; due, so « Échu » with the step since when.
    expect(within(jean).getByText('S37')).toBeInTheDocument()
    expect(within(jean).getByText('Contact à envoyer')).toBeInTheDocument()
    expect(jean.textContent).not.toMatch(/État :|Semaine \d|W37/)
    expect(within(jean).getByText('Échu')).toBeInTheDocument()
    expect(jean).toHaveTextContent('Contact à envoyer depuis le 7 sept. 2026')
    expect(jean).toHaveTextContent('Référent : Camille Référente')

    expect(within(claire).getByText('Ne pas contacter')).toBeInTheDocument()
    expect(claire).toHaveTextContent('Plus en poste')
    expect(within(claire).getByText(/Manque : e-mail absent/)).toBeInTheDocument()
    expect(within(claire).getByText('Pas d’e-mail principal')).toBeInTheDocument()
    expect(claire).toHaveTextContent('Rôle non renseigné')
    expect(within(claire).getByText('Sans semaine de contact')).toBeInTheDocument()

    expect(within(luc).getByText(/Manque : e-mail non vérifié/)).toBeInTheDocument()
    expect(within(luc).getByText('Adresse non vérifiée')).toBeInTheDocument()
    // The level reached by the real sends and the next step, not yet due.
    expect(within(luc).getByText('R1 envoyée')).toBeInTheDocument()
    expect(luc).toHaveTextContent('R2 à envoyer le 14 sept. 2026')
    expect(luc).not.toHaveTextContent('Échu')
    // Every status badge carries a glyph next to its text.
    for (const badge of [jean, claire, luc].flatMap((row) => [...row.querySelectorAll('.badge:not(.badge--tag)')])) {
      expect(badge.querySelector('svg')).not.toBeNull()
      expect(badge.textContent.trim()).not.toBe('')
    }
  })

  it('says what takes a person out of the automatic actions: S0, Défaillant, Relance terminée, Erreur sur le mail', async () => {
    stubProspectionApi({
      prospects: [
        prospect('Odile', 'Horscampagne', { cohort_code: 'S0', level: 'contact_pending' }),
        prospect('Denis', 'Defaillant', { cohort_code: 'S37', level: 'contact_sent', tracking_status: 'disqualified' }),
        prospect('Fanny', 'Finie', { cohort_code: 'S37', level: 'finished', finished: true }),
        prospect('Emma', 'Erreur', { cohort_code: 'S39', level: 'contact_sent', email_error: true }),
      ],
    })
    renderApp('/prospection?segment=all&q=')
    const rows = within(await screen.findByRole('list', { name: 'Prospects' })).getAllByRole('listitem')
    const [odile, denis, fanny, emma] = rows as [HTMLElement, HTMLElement, HTMLElement, HTMLElement]

    expect(odile).toHaveTextContent('S0 · hors campagne')
    // S0 is not in a campaign: no level shown.
    expect(odile).not.toHaveTextContent('Contact à envoyer')
    expect(within(denis).getByText('Défaillant')).toBeInTheDocument()
    expect(within(fanny).getByText('Relance terminée')).toBeInTheDocument()
    expect(within(emma).getByText('Mail invalide')).toBeInTheDocument()
  })

  it('filters on the commercial state, « En séquence » covering people without any tracking', async () => {
    const api = stubProspectionApi({ prospects: people() })
    renderApp('/prospection?segment=all&q=')
    await screen.findByRole('list', { name: 'Prospects' })
    await openFilters()
    const filter = screen.getByRole('combobox', { name: 'État commercial' })
    expect(within(filter).getAllByRole('option').map((option) => option.textContent)).toEqual([
      'Tous les états',
      'En séquence',
      'Réponse reçue',
      'RDV pris',
      'Non intéressé',
      'Ignoré',
      'Défaillant',
    ])
    await userEvent.selectOptions(filter, 'Défaillant')
    await waitFor(() => {
      expect(lastParams(api.requests, PROSPECTS).get('tracking_status')).toBe('disqualified')
    })
  })

  it('filters on a cohort of Paramètres, or on people without any (not validated)', async () => {
    const s39 = cohort('S39', '2026-09-28')
    const api = stubProspectionApi({ prospects: people(), cohorts: [S0, s39] })
    renderApp('/prospection?segment=all&q=')
    await screen.findByRole('list', { name: 'Prospects' })
    await openFilters()
    const filter = screen.getByRole('combobox', { name: 'Semaine de contact' })
    await waitFor(() => {
      expect(within(filter).getAllByRole('option').map((option) => option.textContent)).toEqual([
        'Toutes les semaines de contact',
        'Sans semaine de contact (non validé)',
        'S0 — hors campagne',
        'S39 — 28 sept. 2026',
      ])
    })

    await userEvent.selectOptions(filter, 'S39 — 28 sept. 2026')
    await waitFor(() => {
      expect(lastParams(api.requests, PROSPECTS).get('cohort')).toBe(s39.id)
    })
    await userEvent.selectOptions(filter, 'Sans semaine de contact (non validé)')
    await waitFor(() => {
      expect(lastParams(api.requests, PROSPECTS).get('cohort')).toBe('none')
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
    expect(screen.getAllByRole('link', { name: 'Importer Excel' })).toHaveLength(1)
    await userEvent.click(screen.getByText('Autres actions'))
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
