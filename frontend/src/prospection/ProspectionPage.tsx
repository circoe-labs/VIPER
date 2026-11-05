import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router'

import {
  fetchProspectPage,
  filtersOf,
  PROSPECT_PAGE_SIZE,
  useProspectionCounters,
  useProspectPage,
} from '../api/prospection'
import { ExportWorkbookButton } from '../exports/ExportWorkbookButton'
import { CompanyDirectory } from '../companies/CompanyDirectory'
import { useDebouncedValue } from '../settings/shared'
import { Button } from '../ui/Button'
import { CreationPeriod } from '../ui/CreationPeriod'
import { EmptyState } from '../ui/EmptyState'
import {
  AlertIcon,
  ArrowLeftIcon,
  BuildingIcon,
  CheckCircleIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  PlusIcon,
  SpinnerIcon,
  UploadIcon,
  UsersIcon,
} from '../ui/icons'
import { PageHeader } from '../ui/PageHeader'
import { SearchField } from '../ui/SearchField'
import { DEFAULT_VIEW, hasFilters, hasSelection, parseView, type ProspectionView, serializeView } from './criteria'
import { REVIEW_INFO, SEGMENT_INFO, selectionLabel } from './labels'
import { ProspectionFilters } from './ProspectionFilters'
import { ProspectList } from './ProspectList'
import { useProspectEditor } from './prospectEditor'
import { createProspectQueue, type ProspectQueue } from './queue'
import { OverviewPanel } from './OverviewPanel'
import { ValidationSummary } from './ValidationSummary'
import { ContactActivity } from './ContactActivity'
import './prospection.css'

const NUMBER = new Intl.NumberFormat('fr-FR')
const ADD_UNAVAILABLE = 'Disponible avec l’éditeur de prospect'

function peopleCount(count: number): string {
  return `${NUMBER.format(count)} ${count > 1 ? 'prospects' : 'prospect'}`
}

// Prospection (Task 14): the daily manual-work page. Counters are filters, the list is people-oriented, and every
// criterion lives in the URL (criteria.ts). Opening a prospect follows the editor contract (prospectEditor.tsx).
export function ProspectionPage() {
  const queryClient = useQueryClient()
  const [params, setParams] = useSearchParams()
  const view = parseView(params)
  const { canCreate, Editor } = useProspectEditor()

  // Criteria changes replace the history entry (Back leaves the page, and returns to it as it was); opening a
  // prospect pushes one (Back closes it).
  const update = useCallback(
    (patch: Partial<ProspectionView>, { push = false } = {}) => {
      setParams((current) => serializeView({ ...parseView(current), ...patch }), { replace: !push })
    },
    [setParams],
  )
  const refine = (patch: Partial<ProspectionView>) => {
    update({ ...patch, page: 1 })
  }

  // The search box types freely; the URL follows once typing pauses, and a URL change (Back, reset) refills the box.
  const [draft, setDraft] = useState(view.q)
  const [urlSearch, setUrlSearch] = useState(view.q)
  if (view.q !== urlSearch) {
    setUrlSearch(view.q)
    setDraft(view.q)
  }
  const settled = useDebouncedValue(draft, 250)
  useEffect(() => {
    if (settled === draft && settled !== view.q) update({ q: settled, page: 1 })
  }, [settled, draft, view.q, update])

  const criteria = { ...filtersOf(view), segment: view.segment, review: view.review, sort: view.sort }
  const counters = useProspectionCounters(filtersOf(view))
  const list = useProspectPage(criteria, view.page)
  const page = list.data

  // The queue is the list order when the editor opened (Save & Next, Task 15); it ends when the editor closes.
  const [queue, setQueue] = useState<ProspectQueue | null>(null)
  if (view.prospect === null && queue !== null) setQueue(null)
  if (view.prospect !== null && queue === null && page && !list.isPlaceholderData) {
    setQueue(
      createProspectQueue(criteria, { page: view.page, data: page }, (number) =>
        fetchProspectPage(queryClient, criteria, number),
      ),
    )
  }
  const navigateEditor = useCallback(
    (target: string | null, options: { page?: number } = {}) => {
      update({ prospect: target, ...options })
    },
    [update],
  )

  const openHref = (id: string) => `?${serializeView({ ...view, prospect: id }).toString()}`
  // Start folded on every visit, including links with filters; actions on this page can open it.
  const [showList, setShowList] = useState(false)
  const filtered = hasFilters(view)
  const emptyBase = counters.data?.counts.all === 0 && !filtered
  const last = page ? Math.min(page.offset + page.items.length, page.total) : 0
  const hint = view.validated_only ? 'Emploi validé, indépendamment du statut de vérification de l’e-mail.' : view.segment === 'never_verified' && view.review === 'to_verify' ? 'Aucune validation de l’emploi enregistrée dans VIPER, hors prospects mis de côté.' : view.review ? REVIEW_INFO[view.review].hint : SEGMENT_INFO[view.segment].hint
  const heading = view.validated_only ? `Prospects dont l’emploi est validé${hasSelection(view) ? ` — ${selectionLabel(view)}` : ''}` : view.segment === 'never_verified' && view.review === 'to_verify' ? 'Prospects sans validation de l’emploi enregistrée' : selectionLabel(view)

  return (
    <div className="prospection">
      <Link to="/" className="prospection__back">
        <ArrowLeftIcon size={16} />
        Accueil
      </Link>
      <PageHeader
        title="Prospection"
        description="Vérifier la base, préparer les contacts, suivre les réponses."
        actions={
          <>
            <Link to="/prospection/verification" className="btn btn--primary btn--md">
              <CheckCircleIcon size={18} />
              Vérifier les fiches
            </Link>
            <Link to="/prospection/robin" className="btn btn--secondary btn--md">
              <UsersIcon size={18} />
              Qui connaît Robin ?
            </Link>
            <Link to="/prospection/companies" className="btn btn--ghost btn--md">
              <BuildingIcon size={18} />
              Entreprises
            </Link>
            <Link to="/prospection/import" className="btn btn--secondary btn--md">
              <UploadIcon size={18} />
              Importer Excel
            </Link>
            <ExportWorkbookButton />
            <Button
              variant="primary"
              icon={PlusIcon}
              aria-disabled={!canCreate}
              aria-describedby={canCreate ? undefined : 'prospection-add-unavailable'}
              title={canCreate ? undefined : ADD_UNAVAILABLE}
              onClick={() => {
                if (canCreate) update({ prospect: 'new' }, { push: true })
              }}
            >
              Ajouter un prospect
            </Button>
            {!canCreate && (
              <span id="prospection-add-unavailable" className="visually-hidden">
                {ADD_UNAVAILABLE}
              </span>
            )}
          </>
        }
      />

      {counters.isError && (
        <div className="prospection__state prospection__state--error" role="alert">
          <AlertIcon size={18} />
          Compteurs indisponibles.
          <Button size="sm" onClick={() => void counters.refetch()}>
            Réessayer
          </Button>
        </div>
      )}

      {emptyBase ? (
        <EmptyState
          icon={UsersIcon}
          title="Aucun prospect pour l’instant"
          description="Importez le fichier Excel de prospection pour alimenter la base : chaque ligne est relue avant d’être enregistrée."
          action={
            <Link to="/prospection/import" className="btn btn--primary btn--md">
              <UploadIcon size={18} />
              Importer Excel
            </Link>
          }
        />
      ) : (
        <>
          <OverviewPanel onOpenList={() => { setShowList(true) }} />
          <ValidationSummary onSelect={(patch) => { update({ ...DEFAULT_VIEW, ...patch }); setShowList(true) }} />
          <CreationPeriod start={view.created_from} end={view.created_to} onClear={() => { refine({ created_from: null, created_to: null }) }} />

          <details className="prospection-exploration">
            <summary>Entreprises, recherche et suivi commercial</summary>
          <CompanyDirectory
            value={view.company_kind ?? null}
            onChange={(company_kind) => {
              refine({ company_kind })
              setShowList(true)
            }}
          />

          <div className="prospection-section__head prospection-section__head--selection">
            <h2>Explorer les prospects</h2>
            <span>{filtered ? 'Recherche ou filtres actifs' : 'Tous les prospects · aucun filtre'}</span>
          </div>
          <ProspectionFilters
            view={view}
            onChange={refine}
            search={
              <SearchField label="Rechercher : nom, entreprise, e-mail, téléphone" value={draft} onChange={setDraft} />
            }
          />

          <ContactActivity counters={counters.isError ? undefined : counters.data} active={view.review ? 'all' : view.segment} onSelect={(segment) => { refine({ segment, review: null }); setShowList(true) }} />
          </details>

          <section className="prospection__results" aria-labelledby="prospection-results-title">
            <div className="prospection__results-head">
              <div>
                <h2 id="prospection-results-title" className="prospection__results-title">
                  <button
                    type="button"
                    className="prospection__results-toggle"
                    aria-expanded={showList}
                    aria-controls="prospection-results-body"
                    aria-label={showList ? 'Masquer la liste' : 'Afficher la liste'}
                    onClick={() => {
                      setShowList(!showList)
                    }}
                  >
                    <ChevronDownIcon size={18} />
                  </button>
                  {heading}
                  {page && <span className="prospection__results-count">{peopleCount(page.total)}</span>}
                  {list.isFetching && <SpinnerIcon size={16} className="btn__spinner" />}
                </h2>
                <p className="prospection__results-hint">{hint}</p>
              </div>
              {(filtered || hasSelection(view)) && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    // The box is cleared now: when the cleared URL lands (a navigation, maybe after the next
                    // keystroke), it must not clear again what was typed meanwhile.
                    setDraft('')
                    setUrlSearch('')
                    update({ ...DEFAULT_VIEW, sort: view.sort })
                  }}
                >
                  Réinitialiser
                </Button>
              )}
            </div>

            <div id="prospection-results-body" hidden={!showList}>
            {list.isPending && (
              <p className="prospection__state" role="status">
                <SpinnerIcon size={18} className="btn__spinner" />
                Chargement des prospects…
              </p>
            )}
            {list.isError && (
              <div className="prospection__state prospection__state--error" role="alert">
                <AlertIcon size={18} />
                Liste indisponible.
                <Button size="sm" onClick={() => void list.refetch()}>
                  Réessayer
                </Button>
              </div>
            )}
            {page?.total === 0 && (
              <p className="prospection__state">
                {filtered
                  ? 'Aucun prospect ne correspond à ces critères.'
                  : `Aucun prospect dans « ${heading} » pour l’instant.`}
              </p>
            )}
            {page && page.items.length > 0 && (
              <ProspectList rows={page.items} openHref={openHref} />
            )}
            {page && page.total > PROSPECT_PAGE_SIZE && (
              <nav className="prospection__pager" aria-label="Pages de la liste">
                <span>
                  {page.offset + 1}–{last} sur {NUMBER.format(page.total)}
                </span>
                <Button
                  size="sm"
                  icon={ChevronLeftIcon}
                  disabled={view.page <= 1}
                  onClick={() => {
                    update({ page: view.page - 1 })
                  }}
                >
                  Précédents
                </Button>
                <Button
                  size="sm"
                  icon={ChevronRightIcon}
                  disabled={last >= page.total}
                  onClick={() => {
                    update({ page: view.page + 1 })
                  }}
                >
                  Suivants
                </Button>
              </nav>
            )}
            </div>
          </section>
        </>
      )}

      {view.prospect !== null && queue !== null && (
        <Editor target={view.prospect} queue={queue} onNavigate={navigateEditor} />
      )}
    </div>
  )
}
