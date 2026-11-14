import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useState } from 'react'

import {
  fetchProspectPage,
  filtersOf,
  PROSPECT_PAGE_SIZE,
  useProspectionOverview,
  useProspectPage,
} from '../api/prospection'
import { CompanyKindFilter } from '../companies/CompanyKindFilter'
import { Button } from '../ui/Button'
import { CreationPeriod } from '../ui/CreationPeriod'
import { EmptyState } from '../ui/EmptyState'
import { AlertIcon, ChevronLeftIcon, ChevronRightIcon, PlusIcon, SpinnerIcon, UploadIcon, UsersIcon } from '../ui/icons'
import { Link } from 'react-router'
import { DEFAULT_VIEW, hasFilters, hasSelection, type ProspectionView, serializeView } from './criteria'
import { type Capsule, EntityCapsules } from './EntityCapsules'
import { type EntityPanelProps, weeklyFor } from './entityPanel'
import { REVIEW_INFO, SEGMENT_INFO, selectionLabel } from './labels'
import { ProspectionFilters } from './ProspectionFilters'
import { ProspectList } from './ProspectList'
import { useProspectEditor } from './prospectEditor'
import { createProspectQueue, type ProspectQueue } from './queue'
import { ReachableProspectList } from './ReachableProspectList'
import { type StatusKey, useWeeklyAdditions } from './weeklyAdditions'

const NUMBER = new Intl.NumberFormat('fr-FR')
const ADD_UNAVAILABLE = 'Disponible avec l’éditeur de prospect'

function peopleCount(count: number): string {
  return `${NUMBER.format(count)} ${count > 1 ? 'prospects' : 'prospect'}`
}

// Validation states of the database: each capsule is a figure AND the filter that opens its table. « Emploi validé »
// and the e-mail check are distinct validations (an unverified e-mail never un-validates a job).
const STATES: readonly { key: StatusKey; label: string; hint: string; patch: Partial<ProspectionView>; pressed: (view: ProspectionView) => boolean }[] = [
  { key: 'employment_validated', label: 'Emploi validé', hint: 'Validation de l’emploi enregistrée dans VIPER, indépendamment du statut de l’e-mail', patch: { validated_only: true, segment: 'all', review: null }, pressed: (v) => !!v.validated_only && !v.verification_box },
  { key: 'uncertain', label: 'Incertains', hint: 'Fonction à vérifier', patch: { verification_box: 'uncertain' }, pressed: (v) => v.verification_box === 'uncertain' },
  { key: 'todo', label: 'À vérifier', hint: 'Validation de l’emploi non enregistrée', patch: { verification_box: 'todo' }, pressed: (v) => v.verification_box === 'todo' },
  { key: 'ignored', label: 'Mis de côté', hint: 'Prospects ignorés, conservés dans la base', patch: { validated_only: false, segment: 'all', review: 'ignored' }, pressed: (v) => !v.validated_only && !v.verification_box && v.review === 'ignored' && v.segment === 'all' },
]

// Prospects: validation capsules, search and filters, then the people table directly (no folded section). The editor
// contract (prospectEditor.tsx) is unchanged: `?prospect=<id>|new` opens it and Back closes it.
export function ProspectsPanel({ view, update, refine, search }: EntityPanelProps) {
  const queryClient = useQueryClient()
  const { canCreate, Editor } = useProspectEditor()
  const overview = useProspectionOverview()
  const weekly = useWeeklyAdditions()
  const criteria = { ...filtersOf(view), segment: view.segment, review: view.review, sort: view.sort }
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
  const filtered = hasFilters(view)
  const unselected = !filtered && !hasSelection(view)
  const emptyBase = overview.data?.total === 0 && unselected
  const last = page ? Math.min(page.offset + page.items.length, page.total) : 0
  const hint = view.validated_only ? 'Emploi validé, indépendamment du statut de vérification de l’e-mail.' : view.segment === 'never_verified' && view.review === 'to_verify' ? 'Aucune validation de l’emploi enregistrée dans VIPER, hors prospects mis de côté.' : view.review ? REVIEW_INFO[view.review].hint : SEGMENT_INFO[view.segment].hint
  const boxHeading = view.verification_box ? { validated: 'Prospects validés', uncertain: 'Prospects incertains', todo: 'Prospects à vérifier', ignored: 'Prospects mis de côté' }[view.verification_box] : null
  const heading = boxHeading ?? (view.validated_only ? `Prospects dont l’emploi est validé${hasSelection(view) ? ` — ${selectionLabel(view)}` : ''}` : view.segment === 'never_verified' && view.review === 'to_verify' ? 'Prospects sans validation de l’emploi enregistrée' : selectionLabel(view))

  // « Tous » = the whole base; a weekly delta per state is shown only when the adapter has a truthful one.
  const capsules: Capsule[] = [
    { key: 'all', label: 'Tous', hint: 'Toute la base, hors prospects supprimés', count: overview.data?.total, failed: overview.isError, pressed: unselected && !view.validated_only && !view.verification_box, onSelect: () => { update({ ...DEFAULT_VIEW, page: 1 }) }, weekly: weeklyFor(weekly, 'prospect') },
    ...STATES.map(({ key, label, hint: stateHint, patch, pressed }) => ({ key, label, hint: stateHint, count: overview.data?.[key], failed: overview.isError, pressed: pressed(view), onSelect: () => { update({ ...DEFAULT_VIEW, ...patch }) }, weekly: weekly.byStatus[key] })),
  ]

  return (
    <section aria-label="Prospects">
      <EntityCapsules label="Validation des prospects" capsules={capsules} />
      <CreationPeriod start={view.created_from} end={view.created_to} onClear={() => { refine({ created_from: null, created_to: null }) }} />
      <CompanyKindFilter value={view.company_kind ?? null} onChange={(company_kind) => { refine({ company_kind }) }} />
      <ProspectionFilters view={view} onChange={refine} search={search} />

      <div className="prospection__results-head">
        <div>
          <h2 id="prospection-results-title" className="prospection__results-title">
            {heading}
            {page && <span className="prospection__results-count">{peopleCount(page.total)}</span>}
            {list.isFetching && <SpinnerIcon size={16} className="btn__spinner" />}
          </h2>
          <p className="prospection__results-hint">{hint}</p>
        </div>
        <div className="prospection__results-actions">
          {(filtered || hasSelection(view)) && <Button size="sm" variant="ghost" onClick={() => { update({ ...DEFAULT_VIEW, sort: view.sort }) }}>Réinitialiser</Button>}
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
        </div>
      </div>

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
          {page?.total === 0 && <p className="prospection__state">{filtered ? 'Aucun prospect ne correspond à ces critères.' : `Aucun prospect dans « ${heading} » pour l’instant.`}</p>}
          {page && page.items.length > 0 && (view.validated_only ? <ReachableProspectList rows={page.items} openHref={openHref} /> : <ProspectList rows={page.items} openHref={openHref} />)}
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
