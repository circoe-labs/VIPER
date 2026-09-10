import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router'

import {
  fetchProspectPage,
  filtersOf,
  PROSPECT_PAGE_SIZE,
  type Segment,
  useProspectionCounters,
  useProspectPage,
} from '../api/prospection'
import { ExportWorkbookButton } from '../exports/ExportWorkbookButton'
import { useDebouncedValue } from '../settings/shared'
import { Button } from '../ui/Button'
import { EmptyState } from '../ui/EmptyState'
import {
  AlertIcon,
  BuildingIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  PlusIcon,
  SpinnerIcon,
  UploadIcon,
  UsersIcon,
} from '../ui/icons'
import { PageHeader } from '../ui/PageHeader'
import { SearchField } from '../ui/SearchField'
import { CounterCards } from './CounterCards'
import { DEFAULT_VIEW, hasFilters, parseView, type ProspectionView, serializeView } from './criteria'
import { SEGMENT_INFO } from './labels'
import { ProspectionFilters } from './ProspectionFilters'
import { ProspectList } from './ProspectList'
import { useProspectEditor } from './prospectEditor'
import { createProspectQueue, type ProspectQueue } from './queue'
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

  const criteria = { ...filtersOf(view), segment: view.segment, sort: view.sort }
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
  const filtered = hasFilters(view)
  const emptyBase = counters.data?.counts.all === 0 && !filtered
  const last = page ? Math.min(page.offset + page.items.length, page.total) : 0
  const segment = SEGMENT_INFO[view.segment]

  function selectSegment(next: Segment) {
    refine({ segment: next })
  }

  return (
    <div className="prospection">
      <PageHeader
        title="Prospection"
        description="Vérifier la base, préparer les contacts, suivre les réponses."
        actions={
          <>
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
          <CounterCards counters={counters.data} active={view.segment} onSelect={selectSegment} />

          <ProspectionFilters
            view={view}
            onChange={refine}
            search={
              <SearchField label="Rechercher : nom, entreprise, e-mail, téléphone" value={draft} onChange={setDraft} />
            }
          />

          <section className="prospection__results" aria-labelledby="prospection-results-title">
            <div className="prospection__results-head">
              <div>
                <h2 id="prospection-results-title" className="prospection__results-title">
                  {view.segment === 'all' ? 'Tous les prospects' : segment.label}
                  {page && <span className="prospection__results-count">{peopleCount(page.total)}</span>}
                  {list.isFetching && <SpinnerIcon size={16} className="btn__spinner" />}
                </h2>
                <p className="prospection__results-hint">{segment.hint}</p>
              </div>
              {(filtered || view.segment !== 'all') && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setDraft('')
                    update({ ...DEFAULT_VIEW, sort: view.sort })
                  }}
                >
                  Réinitialiser
                </Button>
              )}
            </div>

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
                  : `Aucun prospect dans « ${segment.label} » pour l’instant.`}
              </p>
            )}
            {page && page.items.length > 0 && <ProspectList rows={page.items} openHref={openHref} />}
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
          </section>
        </>
      )}

      {view.prospect !== null && queue !== null && (
        <Editor target={view.prospect} queue={queue} onNavigate={navigateEditor} />
      )}
    </div>
  )
}
