import { useState } from 'react'
import { Link } from 'react-router'

import { useWarehouseCounts, useWarehouses } from '../api/warehouses'
import { Button } from '../ui/Button'
import { EmptyState } from '../ui/EmptyState'
import { AlertIcon, ChevronLeftIcon, ChevronRightIcon, PlusIcon, SpinnerIcon, UploadIcon, WarehouseIcon } from '../ui/icons'
import { WarehouseEditor } from '../warehouses/WarehouseEditor'
import { WarehouseImport } from '../warehouses/WarehouseImport'
import { WarehouseRow } from '../warehouses/WarehousesPage'
import { WAREHOUSE_CATEGORIES, type WarehouseCategory } from './criteria'
import { type Capsule, EntityCapsules } from './EntityCapsules'
import { type EntityPanelProps, weeklyFor } from './entityPanel'
import { useWeeklyAdditions } from './weeklyAdditions'

const NUMBER = new Intl.NumberFormat('fr-FR')
const PAGE_SIZE = 50 // fixed by `useWarehouses` (limit=50)
const CATEGORY_LABELS: Record<WarehouseCategory, string> = { sme: 'PME/TPE', other: 'Autres', unclassified: 'À classer' }

// Entrepôts: category capsules + « à contacter » (figure + filter), search, then the existing warehouse cards and
// editor/import dialogs. URL: `entity=warehouse`, `warehouse_category`, `warehouse_to_contact`, `q`, `page`.
// Drafts stay on /warehouses (not part of the database overview).
export function WarehousesPanel({ view, update, refine, search }: EntityPanelProps) {
  const counts = useWarehouseCounts()
  const weekly = useWeeklyAdditions()
  const [editing, setEditing] = useState<string | null | undefined>(undefined)
  const [importing, setImporting] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const query = view.q.trim()
  const offset = (view.page - 1) * PAGE_SIZE
  const warehouses = useWarehouses(query, offset, view.warehouse_to_contact, view.warehouse_category)
  const page = warehouses.data
  const last = page ? Math.min(offset + page.items.length, page.total) : 0
  const capsules: Capsule[] = [
    { key: 'all', label: 'Tous', hint: 'Tous les sites du répertoire', count: counts.data?.warehouses, pressed: view.warehouse_category === null && !view.warehouse_to_contact, onSelect: () => { refine({ warehouse_category: null, warehouse_to_contact: false }) }, weekly: weeklyFor(weekly, 'warehouse') },
    ...WAREHOUSE_CATEGORIES.map((category) => ({ key: category, label: CATEGORY_LABELS[category], hint: 'Catégorie de prospection', count: counts.data?.[category], pressed: view.warehouse_category === category, onSelect: () => { refine({ warehouse_category: view.warehouse_category === category ? null : category }) } })),
    { key: 'to_contact', label: 'Interlocuteurs à contacter', hint: 'Interlocuteurs marqués « à contacter » ; la liste montre leurs entrepôts', count: counts.data?.to_contact, pressed: view.warehouse_to_contact, onSelect: () => { refine({ warehouse_to_contact: !view.warehouse_to_contact }) } },
  ].map((capsule) => ({ ...capsule, failed: counts.isError }))
  const filtered = view.warehouse_category !== null || view.warehouse_to_contact || query !== ''

  return (
    <section aria-label="Entrepôts">
      <EntityCapsules label="Catégorie d’entrepôt" capsules={capsules} />
      <div className="entity-panel__toolbar">
        {search}
        {page && <span className="entity-panel__count" aria-live="polite">{NUMBER.format(page.total)} entrepôt{page.total > 1 ? 's' : ''}</span>}
        {warehouses.isFetching && <SpinnerIcon size={16} className="btn__spinner" />}
        <Link to="/warehouses" className="btn btn--ghost btn--md">Brouillons</Link>
        <Button icon={UploadIcon} onClick={() => { setImporting(true) }}>Importer Excel</Button>
        <Button variant="primary" icon={PlusIcon} onClick={() => { setEditing(null) }}>Ajouter un entrepôt</Button>
      </div>
      {counts.isError && <p role="alert" className="prospection__state prospection__state--error"><AlertIcon size={18} />Totaux indisponibles.<Button size="sm" onClick={() => void counts.refetch()}>Réessayer</Button></p>}
      {notice && <p className="warehouse-notice" role="status">{notice}</p>}
      {warehouses.isPending && <p role="status" className="prospection__state"><SpinnerIcon size={18} className="btn__spinner" />Chargement des entrepôts…</p>}
      {warehouses.isError && <p role="alert" className="prospection__state prospection__state--error"><AlertIcon size={18} />Impossible de charger les entrepôts.<Button size="sm" onClick={() => void warehouses.refetch()}>Réessayer</Button></p>}
      {page?.total === 0 && (filtered
        ? <p className="prospection__state">Aucun entrepôt ne correspond à ces critères.</p>
        : <EmptyState icon={WarehouseIcon} title="Votre répertoire d’entrepôts" description="Importez votre fichier Excel ou ajoutez votre premier site, puis renseignez ses propriétaires et interlocuteurs." action={<Button variant="primary" icon={PlusIcon} onClick={() => { setEditing(null) }}>Ajouter le premier entrepôt</Button>} />)}
      {page && <div className="warehouse-list">{page.items.map((warehouse) => <WarehouseRow key={`${warehouse.id}-${String(view.warehouse_to_contact)}`} warehouse={warehouse} onlyToContact={view.warehouse_to_contact} onEdit={() => { setEditing(warehouse.id) }} />)}</div>}
      {page && page.total > PAGE_SIZE && (
        <nav className="prospection__pager" aria-label="Pages des entrepôts">
          <span>{NUMBER.format(offset + 1)}–{NUMBER.format(last)} sur {NUMBER.format(page.total)}</span>
          <Button size="sm" icon={ChevronLeftIcon} disabled={view.page <= 1} onClick={() => { update({ page: view.page - 1 }) }}>Précédents</Button>
          <Button size="sm" icon={ChevronRightIcon} disabled={last >= page.total} onClick={() => { update({ page: view.page + 1 }) }}>Suivants</Button>
        </nav>
      )}
      {editing !== undefined && <WarehouseEditor id={editing} onClose={() => { setEditing(undefined) }} />}
      {importing && <WarehouseImport onClose={() => { setImporting(false) }} onImported={(result) => { setImporting(false); refine({ q: '' }); setNotice(`${String(result.created)} entrepôt(s) ajouté(s), ${String(result.contacts)} interlocuteur(s) importé(s)${result.skipped ? ` · ${String(result.skipped)} entrepôt(s) déjà présent(s)` : ''}.`) }} />}
    </section>
  )
}
