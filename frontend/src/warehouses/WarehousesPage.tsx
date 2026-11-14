import { useState } from 'react'
import { useWarehouseCounts, useWarehouseDrafts, useWarehouseWrites, useWarehouses, type Warehouse, type WarehouseContact } from '../api/warehouses'
import { useDebouncedValue } from '../settings/shared'
import { Button } from '../ui/Button'
import { EmptyState } from '../ui/EmptyState'
import { BuildingIcon, ChevronDownIcon, ChevronLeftIcon, ChevronRightIcon, MapPinIcon, PlusIcon, UploadIcon, UsersIcon, WarehouseIcon } from '../ui/icons'
import { PageHeader } from '../ui/PageHeader'
import { SearchField } from '../ui/SearchField'
import { WarehouseEditor, warehouseError } from './WarehouseEditor'
import { WarehouseImport } from './WarehouseImport'
import { WarehouseDrafts } from './WarehouseDrafts'
import './warehouses.css'

// The source role is free text; keep the original order when no priority can be inferred.
function contactPriority(contact: WarehouseContact): number {
  const role = (contact.role ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  if (/\b(directeur|directrice)\b/.test(role)) return 0
  if (/logistique/.test(role) && /\b(gerant|gerante|responsable|gestionnaire|manager|chef|cheffe)\b/.test(role)) return 1
  return 2
}

function LinkedIn({ url }: { url: string | null }) {
  if (!url) return null
  let safe = false
  try {
    const parsed = new URL(url)
    safe = parsed.protocol === 'https:' || parsed.protocol === 'http:'
  } catch { /* Keep an invalid source URL as readable text. */ }
  return safe ? <a href={url} target="_blank" rel="noopener noreferrer">Profil LinkedIn</a> : <span>{url}</span>
}

export function WarehouseRow({ warehouse, onEdit, onlyToContact }: { warehouse: Warehouse; onEdit: () => void; onlyToContact: boolean }) {
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [baseline, setBaseline] = useState(warehouse)
  const [selection, setSelection] = useState(() => warehouse.contacts.map((contact) => contact.to_contact ?? false))
  const { save } = useWarehouseWrites()
  const changed = baseline.contacts.some((contact, index) => (contact.to_contact ?? false) !== selection[index])
  if (!changed && warehouse.version !== baseline.version) {
    setBaseline(warehouse)
    setSelection(warehouse.contacts.map((contact) => contact.to_contact ?? false))
  }
  const contacts = baseline.contacts.map((contact, index) => ({ contact, index }))
    .filter(({ contact, index }) => !onlyToContact || contact.to_contact || selection[index])
    .sort((a, b) => Number(selection[b.index]) - Number(selection[a.index]) || contactPriority(a.contact) - contactPriority(b.contact))
  async function validateSelection() {
    setError(null)
    try {
      const saved = await save.mutateAsync({ id: baseline.id, version: baseline.version, data: { ...baseline, contacts: baseline.contacts.map((contact, index) => ({ ...contact, to_contact: selection[index] ?? false })) } })
      setBaseline(saved)
      setSelection(saved.contacts.map((contact) => contact.to_contact ?? false))
    } catch (caught) { setError(warehouseError(caught)) }
  }
  return <article className="warehouse-card">
    <div className="warehouse-card__header">
      <button className="warehouse-card__toggle" type="button" aria-label={`Détails de ${warehouse.name}`} aria-expanded={open} aria-controls={`warehouse-${warehouse.id}`} onClick={() => { setOpen(!open) }}>
        <ChevronDownIcon className={open ? 'warehouse-card__chevron--open' : ''} size={26} />
        <span className="warehouse-card__icon"><WarehouseIcon size={22} /></span>
        <span className="warehouse-card__identity"><strong>{warehouse.name}</strong><span>{warehouse.contacts.length} interlocuteur{warehouse.contacts.length > 1 ? 's' : ''}{warehouse.city ? ` · ${warehouse.city}` : ''} · {warehouse.prospecting_category === 'sme' ? 'PME/TPE' : warehouse.prospecting_category === 'other' ? 'Autres' : 'À classer'}</span></span>
      </button>
      <Button size="sm" onClick={onEdit} aria-label={`Modifier ${warehouse.name}`}>Modifier</Button>
    </div>
    <div id={`warehouse-${warehouse.id}`} hidden={!open} className="warehouse-card__details">
      <section className="warehouse-owner" aria-label={`Propriétaire de ${warehouse.name}`}>
        <h3><BuildingIcon size={16} /> Propriétaire immobilier ou foncier</h3>
        {warehouse.owner_name ? <p><strong>{warehouse.owner_name}</strong>{warehouse.owner_role && <span> · {warehouse.owner_role}</span>}</p> : <p className="warehouse-muted">Propriétaire à renseigner</p>}
        {warehouse.owner_email && <p className="warehouse-contact-email"><strong>E-mail : </strong>{warehouse.owner_email}</p>}
        <LinkedIn url={warehouse.owner_linkedin} />
      </section>
      {(warehouse.address || warehouse.city || warehouse.siret) && <div className="warehouse-address">
        <MapPinIcon size={17} /><p>{[warehouse.address, warehouse.postal_code, warehouse.city].filter(Boolean).join(' · ')}{warehouse.siret && <span>SIRET : {warehouse.siret}</span>}</p>
      </div>}
      <h3>Interlocuteurs à contacter</h3>
      <p className="warehouse-muted">Coordonnées à vérifier avant contact.</p>
      {warehouse.contacts.length === 0 ? <p className="warehouse-muted">Aucun interlocuteur renseigné pour le moment.</p> : <ul className="warehouse-contacts" aria-label={`Interlocuteurs de ${warehouse.name}`}>
        {contacts.map(({ contact, index }) => <li key={index}>
          <label className="warehouse-contact-select"><input type="checkbox" checked={selection[index] ?? false} disabled={save.isPending} onChange={(event) => {
            const checked = event.target.checked
            setSelection((current) => current.map((value, position) => position === index ? checked : value))
            setError(null)
          }} /> À contacter prochainement</label>
          <strong className="warehouse-contact-name">{contact.full_name}</strong>
          {contact.role && <p className="warehouse-contact-role"><strong>Fonction : </strong>{contact.role}</p>}
          {contact.email && <p className="warehouse-contact-email"><strong>E-mail : </strong>{contact.email}</p>}
          <LinkedIn url={contact.linkedin} />
        </li>)}
      </ul>}
      {baseline.contacts.length > 0 && <div className="warehouse-selection-actions">
        <Button variant="primary" disabled={!changed || save.isPending} loading={save.isPending} onClick={() => { void validateSelection() }}>Valider la sélection</Button>
        {changed && <span className="warehouse-muted">Sélection non enregistrée</span>}
      </div>}
      {error && <p className="warehouse-error" role="alert">{error}</p>}
      {warehouse.notes && <p className="warehouse-notes"><strong>Notes : </strong>{warehouse.notes}</p>}
      {warehouse.source_reference && <p className="warehouse-source">Source : {warehouse.source_reference}</p>}
    </div>
  </article>
}

export function WarehousesPage() {
  const [search, setSearch] = useState('')
  const [offset, setOffset] = useState(0)
  const [editing, setEditing] = useState<string | null | undefined>(undefined)
  const [importing, setImporting] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [onlyToContact, setOnlyToContact] = useState(false)
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [category, setCategory] = useState<'sme' | 'other' | 'unclassified' | null>(null)
  const [showDrafts, setShowDrafts] = useState<'sme' | 'other' | 'unclassified' | null>(null)
  const counts = useWarehouseCounts()
  const drafts = useWarehouseDrafts()
  const query = useWarehouses(useDebouncedValue(search.trim(), 250), offset, onlyToContact, category)
  const page = query.data
  return <div className="warehouses-page">
    <PageHeader mascot="build" title="Entrepôts" description="Les sites, leurs propriétaires et vos interlocuteurs."
      actions={<><Button icon={UploadIcon} onClick={() => { setImporting(true) }}>Importer Excel</Button><Button variant="primary" icon={PlusIcon} onClick={() => { setEditing(null) }}>Ajouter un entrepôt</Button></>} />
    <section className="warehouse-totals" aria-label="Totaux des entrepôts" aria-busy={counts.isPending}>
      <div><WarehouseIcon size={20} /><span>Entrepôts</span><strong>{counts.data ? counts.data.warehouses.toLocaleString('fr-FR') : '—'}</strong></div>
      <div><UsersIcon size={20} /><span>Interlocuteurs</span><strong>{counts.data ? counts.data.contacts.toLocaleString('fr-FR') : '—'}</strong></div>
      {counts.isError && <p className="warehouse-error" role="alert">Totaux indisponibles. <Button size="sm" onClick={() => void counts.refetch()}>Réessayer</Button></p>}
    </section>
    <div className="warehouse-categories" aria-label="Catégorie des interlocuteurs">
      <Button variant={!showDrafts && !onlyToContact ? 'primary' : 'secondary'} aria-pressed={!showDrafts && !onlyToContact} onClick={() => { setShowDrafts(null); setOnlyToContact(false); setOffset(0) }}>Tous les entrepôts</Button>
      <Button variant={!showDrafts && onlyToContact ? 'primary' : 'secondary'} aria-pressed={!showDrafts && onlyToContact} onClick={() => { setShowDrafts(null); setOnlyToContact(true); setOffset(0) }}>À contacter{counts.data ? ` (${String(counts.data.to_contact)})` : ''}</Button>
      <Button variant={showDrafts ? 'primary' : 'secondary'} aria-pressed={Boolean(showDrafts)} onClick={() => { setShowDrafts('sme') }}>Brouillons</Button>
    </div>
    {!showDrafts && <>
    <div className="warehouse-filter-panel">
      <button type="button" className="warehouse-filter-panel__toggle" aria-expanded={filtersOpen} aria-controls="warehouse-prospecting-filters" onClick={() => { setFiltersOpen(!filtersOpen) }}>
        <ChevronDownIcon className={filtersOpen ? 'warehouse-card__chevron--open' : ''} size={18} />
        Catégorie de prospection : {showDrafts ? `Brouillons ${showDrafts === 'sme' ? 'PME/TPE' : showDrafts === 'other' ? 'Autres' : 'À classer'}` : category === 'sme' ? 'PME/TPE' : category === 'other' ? 'Autres' : category === 'unclassified' ? 'À classer' : 'Toutes'}
      </button>
      <div id="warehouse-prospecting-filters" className="warehouse-categories" role="group" aria-label="Catégorie de prospection" hidden={!filtersOpen}>
      {([ [null, 'Toutes', counts.data?.warehouses], ['sme', 'PME/TPE', counts.data?.sme], ['other', 'Autres', counts.data?.other], ['unclassified', 'À classer', counts.data?.unclassified] ] as const).map(([value, label, count]) => <Button key={value ?? 'all'} variant={category === value ? 'primary' : 'secondary'} aria-pressed={category === value} onClick={() => { setCategory(value); setOffset(0) }}>{label}{count !== undefined ? ` (${String(count)})` : ''}</Button>)}
    </div>
      </div>
    </>}
    {showDrafts && <div className="warehouse-categories" role="group" aria-label="Catégories de brouillons">
      <Button aria-pressed={showDrafts === 'sme'} variant={showDrafts === 'sme' ? 'primary' : 'secondary'} onClick={() => setShowDrafts('sme')}>Brouillons PME/TPE ({drafts.data?.filter(d => d.prospecting_category === 'sme').length ?? 0})</Button>
      <Button aria-pressed={showDrafts === 'other'} variant={showDrafts === 'other' ? 'primary' : 'secondary'} onClick={() => setShowDrafts('other')}>Brouillons Autres entreprises ({drafts.data?.filter(d => d.prospecting_category === 'other').length ?? 0})</Button>
      {drafts.data?.some(d => !d.prospecting_category) && <p>Classez les entrepôts sans catégorie pour accéder à leurs brouillons.</p>}
    </div>}
    {showDrafts ? <WarehouseDrafts key={showDrafts} category={showDrafts} /> : <>
    <div className="warehouse-toolbar">
      <SearchField label="Rechercher un entrepôt, un propriétaire, un interlocuteur…" value={search} onChange={(value) => { setSearch(value); setOffset(0) }} />
      <span className="warehouse-muted" aria-live="polite">{page ? `${String(page.total)} entrepôt${page.total > 1 ? 's' : ''}` : '—'}</span>
      {search && <Button size="sm" variant="ghost" onClick={() => { setSearch(''); setOffset(0) }}>Réinitialiser</Button>}
    </div>
    {notice && <p className="warehouse-notice" role="status">{notice}</p>}
    {query.isPending && <p role="status" className="warehouse-muted">Chargement des entrepôts…</p>}
    {query.isError && <p role="alert" className="warehouse-error">Impossible de charger les entrepôts. <Button onClick={() => void query.refetch()}>Réessayer</Button></p>}
    {page?.total === 0 && !query.isError && (onlyToContact ? <p className="warehouse-muted">Aucun interlocuteur à contacter ne correspond à cette sélection.</p> : search || category ? <p className="warehouse-muted">Aucun entrepôt ne correspond à cette sélection.</p> : <EmptyState icon={WarehouseIcon} title="Votre répertoire d’entrepôts" description="Importez votre fichier Excel ou ajoutez votre premier site, puis renseignez ses propriétaires et interlocuteurs." action={<Button variant="primary" icon={PlusIcon} onClick={() => { setEditing(null) }}>Ajouter le premier entrepôt</Button>} />)}
    <div className="warehouse-list">{page?.items.map((warehouse) => <WarehouseRow key={`${warehouse.id}-${String(onlyToContact)}`} warehouse={warehouse} onlyToContact={onlyToContact} onEdit={() => { setEditing(warehouse.id) }} />)}</div>
    {page && page.total > 50 && <nav className="warehouse-pagination" aria-label="Pages des entrepôts"><span>{offset + 1}–{Math.min(offset + page.items.length, page.total)} sur {page.total}</span><Button icon={ChevronLeftIcon} disabled={offset === 0} onClick={() => { setOffset(offset - 50) }}>Précédents</Button><Button icon={ChevronRightIcon} disabled={offset + 50 >= page.total} onClick={() => { setOffset(offset + 50) }}>Suivants</Button></nav>}
    </>}
    {editing !== undefined && <WarehouseEditor id={editing} onClose={() => { setEditing(undefined) }} />}
    {importing && <WarehouseImport onClose={() => { setImporting(false) }} onImported={(result) => { setImporting(false); setSearch(''); setOffset(0); setNotice(`${String(result.created)} entrepôt(s) ajouté(s), ${String(result.contacts)} interlocuteur(s) importé(s)${result.skipped ? ` · ${String(result.skipped)} entrepôt(s) déjà présent(s)` : ''}.`) }} />}
  </div>
}
