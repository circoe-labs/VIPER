import { useCallback, useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router'

import { ExportWorkbookButton } from '../exports/ExportWorkbookButton'
import { useDebouncedValue } from '../settings/shared'
import { CheckCircleIcon, ChevronDownIcon, UploadIcon, UsersIcon } from '../ui/icons'
import { PageHeader } from '../ui/PageHeader'
import { SearchField } from '../ui/SearchField'
import { CompaniesPanel } from './CompaniesPanel'
import { parseView, type ProspectionView, serializeView } from './criteria'
import { EntityNav } from './EntityNav'
import { ProspectsPanel } from './ProspectsPanel'
import { WarehousesPanel } from './WarehousesPanel'
import './prospection.css'

const SEARCH_LABELS = {
  prospect: 'Rechercher un prospect (nom, entreprise, e-mail, téléphone)',
  company: 'Rechercher une entreprise (nom, raison sociale, SIREN, SIRET, domaine)',
  warehouse: 'Rechercher un entrepôt (nom, propriétaire, interlocuteur)',
}

// Prospection: the state of the database. The entity selector (`?entity=`: Prospects by default, Entreprises,
// Entrepôts) decides the content of the page: KPI cards, one control row (search, sort, filters, chips), then the table. Every
// criterion lives in the URL (criteria.ts). Opening a prospect follows the editor contract (prospectEditor.tsx).
export function ProspectionPage() {
  const [params, setParams] = useSearchParams()
  const view = parseView(params)

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
  const search = <SearchField label={SEARCH_LABELS[view.entity]} value={draft} onChange={setDraft} />

  const [actionsOpen, setActionsOpen] = useState(false)
  const panel = { view, update, refine, search }

  return (
    <div className="prospection prospection--overview">
      <PageHeader mascot="search"
        back={{ to: '/', label: 'Accueil' }}
        title="Prospection"
        description="L’état de la base : prospects, entreprises, entrepôts."
        actions={
          <>
            <Link to="/prospection/verification" className="btn btn--primary btn--md">
              <CheckCircleIcon size={18} />
              Vérifier les fiches
            </Link>
            <details className="prospection-actions" onToggle={(event) => { setActionsOpen(event.currentTarget.open) }} onKeyDown={(event) => { if (event.key === 'Escape') { event.currentTarget.open = false; event.currentTarget.querySelector('summary')?.focus() } }}>
              <summary className="btn btn--secondary btn--md">Autres actions <ChevronDownIcon size={18} /></summary>
              <div className="prospection-actions__menu" hidden={!actionsOpen}>
                <Link to="/prospection/robin" className="btn btn--ghost btn--md">
                  <UsersIcon size={18} />
                  Qui connaît Robin ?
                </Link>
                <Link to="/prospection/import" className="btn btn--ghost btn--md">
                  <UploadIcon size={18} />
                  Importer Excel
                </Link>
                <ExportWorkbookButton variant="ghost" />
              </div>
            </details>
          </>
        }
      />
      <EntityNav view={view} />
      {view.entity === 'company' ? <CompaniesPanel {...panel} /> : view.entity === 'warehouse' ? <WarehousesPanel {...panel} /> : <ProspectsPanel {...panel} />}
    </div>
  )
}
