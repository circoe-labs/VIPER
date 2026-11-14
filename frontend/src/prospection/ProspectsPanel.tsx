import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useState } from 'react'

import {
  fetchProspectPage,
  type ProspectSort,
  filtersOf,
  PROSPECT_PAGE_SIZE,
  useProspectionOverview,
  useProspectPage,
} from '../api/prospection'
import { Button } from '../ui/Button'
import { EmptyState } from '../ui/EmptyState'
import { AlertIcon, ChevronLeftIcon, ChevronRightIcon, PlusIcon, SpinnerIcon, UploadIcon, UsersIcon } from '../ui/icons'
import { Link } from 'react-router'
import { serializeView, sortFor } from './criteria'
import type { EntityPanelProps } from './entityPanel'
import { activeFilters } from './filterChips'
import { EntityToolbar } from './EntityToolbar'
import { ProspectionControls } from './ProspectionFilters'
import { ProspectList } from './ProspectList'
import { useProspectEditor } from './prospectEditor'
import { createProspectQueue, type ProspectQueue } from './queue'

const NUMBER = new Intl.NumberFormat('fr-FR')
const ADD_UNAVAILABLE = 'Disponible avec l’éditeur de prospect'

function peopleCount(count: number): string {
  return `${NUMBER.format(count)} ${count > 1 ? 'prospects' : 'prospect'}`
}

// Prospects: control bar (search, sort, filters + chips), then the people table directly. A filter only restricts this
// list, in this layout (« Emploi validé » included). The editor
// contract (prospectEditor.tsx) is unchanged: `?prospect=<id>|new` opens it and Back closes it.
export function ProspectsPanel({ view, update, refine, search }: EntityPanelProps) {
  const queryClient = useQueryClient()
  const { canCreate, Editor } = useProspectEditor()
  const overview = useProspectionOverview()
  const criteria = { ...filtersOf(view), segment: view.segment, review: view.review, sort: sortFor(view) as ProspectSort }
  const list = useProspectPage(criteria, view.page)
  const page = list.data

  // The queue is the list order when the editor opened (Save & Next); it ends when the editor closes.
  const [queue, setQueue] = useState<ProspectQueue | null>(null)
  if (view.prospect === null && queue !== null) setQueue(null)
  if (view.prospect !== null && queue === null && page && !list.isPlaceholderData) {
    setQueue(createProspectQueue(criteria, { page: view.page, data: page }, (number) => fetchProspectPage(queryClient, criteria, number)))
  }
  const navigateEditor = useCallback((target: string | null, options: { page?: number } = {}) => { update({ prospect: target, ...options }) }, [update])

  const openHref = (id: string) => `?${serializeView({ ...view, prospect: id }).toString()}`
  const filtered = activeFilters(view).length > 0 || view.q.trim() !== ''
  const emptyBase = overview.data?.total === 0 && !filtered
  const last = page ? Math.min(page.offset + page.items.length, page.total) : 0

  return (
    <section aria-label="Prospects">
      <ProspectionControls view={view} onChange={refine} search={search} />

      <EntityToolbar
        title="Tous les prospects"
        count={page ? peopleCount(page.total) : undefined}
        description="Toutes les personnes de la base."
        busy={list.isFetching}
        actions={
          <>
            <Button
              variant="primary"
              icon={PlusIcon}
              aria-disabled={!canCreate}
              aria-describedby={canCreate ? undefined : 'prospection-add-unavailable'}
              title={canCreate ? undefined : ADD_UNAVAILABLE}
              onClick={() => { if (canCreate) update({ prospect: 'new' }, { push: true }) }}
            >
              Ajouter un prospect
            </Button>
            {!canCreate && <span id="prospection-add-unavailable" className="visually-hidden">{ADD_UNAVAILABLE}</span>}
          </>
        }
      />

      {overview.isError && (
        <div className="prospection__state prospection__state--error" role="alert">
          <AlertIcon size={18} />
          Compteurs indisponibles.
          <Button size="sm" onClick={() => void overview.refetch()}>Réessayer</Button>
        </div>
      )}
      {emptyBase && (
        <EmptyState
          icon={UsersIcon}
          title="Aucun prospect pour l’instant"
          description="Importez le fichier Excel de prospection pour alimenter la base : chaque ligne est relue avant d’être enregistrée."
          action={<Link to="/prospection/import" className="btn btn--primary btn--md"><UploadIcon size={18} />Importer Excel</Link>}
        />
      )}
      {!emptyBase && (
        <>
          {list.isPending && <p className="prospection__state" role="status"><SpinnerIcon size={18} className="btn__spinner" />Chargement des prospects…</p>}
          {list.isError && (
            <div className="prospection__state prospection__state--error" role="alert">
              <AlertIcon size={18} />
              Liste indisponible.
              <Button size="sm" onClick={() => void list.refetch()}>Réessayer</Button>
            </div>
          )}
          {page?.total === 0 && <p className="prospection__state">{filtered ? 'Aucun prospect ne correspond à ces critères.' : `Aucun prospect pour l’instant.`}</p>}
          {page && page.items.length > 0 && <ProspectList rows={page.items} openHref={openHref} />}
          {page && page.total > PROSPECT_PAGE_SIZE && (
            <nav className="prospection__pager" aria-label="Pages de la liste">
              <span>{page.offset + 1}–{last} sur {NUMBER.format(page.total)}</span>
              <Button size="sm" icon={ChevronLeftIcon} disabled={view.page <= 1} onClick={() => { update({ page: view.page - 1 }) }}>Précédents</Button>
              <Button size="sm" icon={ChevronRightIcon} disabled={last >= page.total} onClick={() => { update({ page: view.page + 1 }) }}>Suivants</Button>
            </nav>
          )}
        </>
      )}

      {view.prospect !== null && queue !== null && <Editor target={view.prospect} queue={queue} onNavigate={navigateEditor} />}
    </section>
  )
}
