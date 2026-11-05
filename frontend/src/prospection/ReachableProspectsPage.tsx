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
import { useDebouncedValue } from '../settings/shared'
import { Button } from '../ui/Button'
import { EmptyState } from '../ui/EmptyState'
import {
  AlertIcon,
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
import {
  DEFAULT_VIEW,
  hasFilters,
  parseView,
  type ProspectionView,
  serializeView,
} from './criteria'
import { selectionLabel } from './labels'
import { ReachableProspectionFilters } from './ReachableProspectionFilters'
import { ReachableProspectList } from './ReachableProspectList'
import { useProspectEditor } from './prospectEditor'
import { createProspectQueue, type ProspectQueue } from './queue'
import { ProspectsDashboard } from './ProspectsDashboard'
import { SERVICES } from './services'
import { SelectField } from '../ui/fields'
import './prospection.css'
import './prospects-dashboard.css'

const NUMBER = new Intl.NumberFormat('fr-FR')
const ADD_UNAVAILABLE = 'Disponible avec l’éditeur de prospect'

// Prospection (Task 14): the daily manual-work page. Counters are filters, the list is people-oriented, and every
// criterion lives in the URL (criteria.ts). Opening a prospect follows the editor contract (prospectEditor.tsx).
export function ReachableProspectsPage() {
  const queryClient = useQueryClient()
  const [params, setParams] = useSearchParams()
  const parsed = parseView(params)
  // Exactly the validated box in Verification, independent of e-mail checks/reachability.
  const view = {
    ...parsed,
    review: null,
    reachable: false,
    validated_only: true,
    sort: 'company' as const,
    page: parsed.review ? 1 : parsed.page,
  }
  const { canCreate, Editor } = useProspectEditor()

  // Criteria changes replace the history entry (Back leaves the page, and returns to it as it was); opening a
  // prospect pushes one (Back closes it).
  const update = useCallback(
    (patch: Partial<ProspectionView>, { push = false } = {}) => {
      setParams((current) => serializeView({ ...parseView(current), ...patch, review: null, validated_only: true, sort: 'company' }), { replace: !push })
    },
    [setParams],
  )
  const refine = (patch: Partial<ProspectionView>) => {
    setShowList(true)
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
  // Each visit starts folded; opening preserves all URL criteria and the current page.
  const [showList, setShowList] = useState(false)
  const filtered = hasFilters(view)
  const emptyBase = counters.data?.counts.all === 0 && !filtered
  const last = page ? Math.min(page.offset + page.items.length, page.total) : 0
  const heading = selectionLabel(view)

  return (
    <div className="prospection prospects-dashboard">
      <PageHeader
        title="Prospects validés"
        description="Les fiches validées dans Prospection → Vérification."
        actions={
          <>
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

      <details className="prospects-tools">
        <summary>Outils de la base</summary>
        <div>
          {' '}
          <Link to="/prospection/verification" className="btn btn--ghost btn--md">
            <CheckCircleIcon size={18} />
            Vérifier les fiches
          </Link>
          <Link to="/prospection/robin" className="btn btn--ghost btn--md">
            <UsersIcon size={18} />
            Qui connaît Robin ?
          </Link>
          <Link to="/prospection/companies" className="btn btn--ghost btn--md">
            <BuildingIcon size={18} />
            Entreprises
          </Link>
          <Link to="/prospection/import" className="btn btn--ghost btn--md">
            <UploadIcon size={18} />
            Importer Excel
          </Link>
          <ExportWorkbookButton />
        </div>
      </details>

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
          <ProspectsDashboard
            stage={view.send_stage}
            due={view.segment === 'due'}
            onStage={(stage) => {
              refine({ send_stage: view.send_stage === stage ? null : stage, segment: 'all' })
            }}
            onDue={() => {
              refine({ segment: view.segment === 'due' ? 'all' : 'due', send_stage: null })
            }}
          />
          <section className="dashboard-panel services-panel" aria-labelledby="services-title">
            <div className="section-heading">
              <div>
                <h2 id="services-title">Prestations proposées</h2>
                <p>Identifiez les besoins des entreprises et personnalisez votre approche.</p>
              </div>
              <span className="section-caption">Plusieurs choix possibles · au moins une correspondance</span>
            </div>
            <div className="service-filters">
              {SERVICES.map(({ code, label, icon: Icon }) => {
                const selected = view.services?.includes(code) ?? false
                return (
                  <button
                    type="button"
                    key={code}
                    className={`service-choice service-choice--${code}`}
                    aria-pressed={selected}
                    onClick={() => {
                      refine({
                        services: selected
                          ? (view.services ?? []).filter((item) => item !== code)
                          : [...(view.services ?? []), code],
                      })
                    }}
                  >
                    <Icon size={21} />
                    <span>{label}</span>
                    {selected && <CheckCircleIcon size={16} />}
                  </button>
                )
              })}
            </div>
          </section>

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
                  Liste des prospects validés{' '}
                  {page && <span className="prospection__results-count">({NUMBER.format(page.total)})</span>}
                  {list.isFetching && <SpinnerIcon size={16} className="btn__spinner" />}
                </h2>
                <p className="prospection__results-hint">Prospects validés regroupés par entreprise, par ordre alphabétique.</p>
              </div>
              {(filtered || view.segment !== 'all') && (
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
              <div className="prospects-list-filters">
                <ReachableProspectionFilters
                  view={view}
                  onChange={refine}
                  search={
                    <SearchField
                      label="Rechercher : nom, entreprise, e-mail, téléphone"
                      value={draft}
                      onChange={setDraft}
                    />
                  }
                />
                <SelectField
                  label="Catégorie"
                  value={view.company_kind ?? ''}
                  onChange={(event) => {
                    refine({ company_kind: (event.target.value || null) as ProspectionView['company_kind'] })
                  }}
                >
                  <option value="">Toutes les catégories</option>
                  <option value="sme">PME</option>
                  <option value="large">Grosses entreprises</option>
                  <option value="institutional">Institutionnel</option>
                  <option value="unclassified">À classer</option>
                </SelectField>
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
                    : `Aucun prospect dans « ${heading} » pour l’instant.`}
                </p>
              )}
              {page && page.items.length > 0 && <ReachableProspectList rows={page.items} openHref={openHref} />}
              {page && page.total > 0 && (
                <nav className="prospection__pager" aria-label="Pages de la liste">
                  <span>
                    Affichage de {page.offset + 1} à {last} sur {NUMBER.format(page.total)} prospects
                  </span>
                  <Button
                    size="sm"
                    icon={ChevronLeftIcon}
                    disabled={view.page <= 1}
                    onClick={() => {
                      update({ page: view.page - 1 })
                    }}
                  >
                    Précédent
                  </Button>
                  {Array.from(
                    { length: Math.min(5, Math.ceil(page.total / PROSPECT_PAGE_SIZE)) },
                    (_, index) => {
                      const count = Math.ceil(page.total / PROSPECT_PAGE_SIZE)
                      const number = Math.max(1, Math.min(view.page - 2, count - 4)) + index
                      return (
                        <button
                          className="page-number"
                          type="button"
                          key={number}
                          aria-current={number === view.page ? 'page' : undefined}
                          aria-label={`Page ${String(number)}`}
                          onClick={() => {
                            update({ page: number })
                          }}
                        >
                          {number}
                        </button>
                      )
                    },
                  )}
                  <Button
                    size="sm"
                    icon={ChevronRightIcon}
                    disabled={last >= page.total}
                    onClick={() => {
                      update({ page: view.page + 1 })
                    }}
                  >
                    Suivant
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
