import { useState } from 'react'
import { useWarehouseCounts, useWarehouseWrites, useWarehouses, type Warehouse, type WarehouseContact } from '../api/warehouses'
import { useDebouncedValue } from '../settings/shared'
import { Button } from '../ui/Button'
import { EmptyState } from '../ui/EmptyState'
import { BuildingIcon, ChevronDownIcon, ChevronLeftIcon, ChevronRightIcon, MapPinIcon, PlusIcon, UploadIcon, UsersIcon, WarehouseIcon } from '../ui/icons'
import { PageHeader } from '../ui/PageHeader'
import { SearchField } from '../ui/SearchField'
import { WarehouseEditor, warehouseError } from './WarehouseEditor'
import { WarehouseImport } from './WarehouseImport'
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

function WarehouseRow({ warehouse, onEdit, onlyToContact }: { warehouse: Warehouse; onEdit: () => void; onlyToContact: boolean }) {
  const [open, setOpen] = useState(onlyToContact)
  const [error, setError] = useState<string | null>(null)
  const { save } = useWarehouseWrites()
  const contacts = warehouse.contacts.map((contact, index) => ({ contact, index }))
    .filter(({ contact }) => !onlyToContact || contact.to_contact)
    .sort((a, b) => contactPriority(a.contact) - contactPriority(b.contact))
  return <article className="warehouse-card">
    <div className="warehouse-card__header">
      <button className="warehouse-card__toggle" type="button" aria-label={`Détails de ${warehouse.name}`} aria-expanded={open} aria-controls={`warehouse-${warehouse.id}`} onClick={() => { setOpen(!open) }}>
        <ChevronDownIcon className={open ? 'warehouse-card__chevron--open' : ''} size={26} />
        <span className="warehouse-card__icon"><WarehouseIcon size={22} /></span>
        <span className="warehouse-card__identity"><strong>{warehouse.name}</strong><span>{warehouse.contacts.length} interlocuteur{warehouse.contacts.length > 1 ? 's' : ''}{warehouse.city ? ` · ${warehouse.city}` : ''}</span></span>
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
          <label className="warehouse-contact-select"><input type="checkbox" checked={contact.to_contact ?? false} disabled={save.isPending} onChange={(event) => {
            const checked = event.target.checked
            setError(null)
            void save.mutateAsync({ id: warehouse.id, version: warehouse.version, data: { ...warehouse, contacts: warehouse.contacts.map((item, position) => position === index ? { ...item, to_contact: checked } : item) } }).catch((caught: unknown) => { setError(warehouseError(caught)) })
          }} /> À contacter prochainement</label>
          <strong className="warehouse-contact-name">{contact.full_name}</strong>
          {contact.role && <p className="warehouse-contact-role"><strong>Fonction : </strong>{contact.role}</p>}
          {contact.email && <p className="warehouse-contact-email"><strong>E-mail : </strong>{contact.email}</p>}
          <LinkedIn url={contact.linkedin} />
        </li>)}
      </ul>}
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
  const counts = useWarehouseCounts()
  const query = useWarehouses(useDebouncedValue(search.trim(), 250), offset, onlyToContact)
  const page = query.data
  return <div className="warehouses-page">
    <PageHeader title="Entrepôts" description="Les sites, leurs propriétaires et vos interlocuteurs."
      actions={<><Button icon={UploadIcon} onClick={() => { setImporting(true) }}>Importer Excel</Button><Button variant="primary" icon={PlusIcon} onClick={() => { setEditing(null) }}>Ajouter un entrepôt</Button></>} />
    <section className="warehouse-totals" aria-label="Totaux des entrepôts" aria-busy={counts.isPending}>
      <div><WarehouseIcon size={20} /><span>Entrepôts</span><strong>{counts.data ? counts.data.warehouses.toLocaleString('fr-FR') : '—'}</strong></div>
      <div><UsersIcon size={20} /><span>Interlocuteurs</span><strong>{counts.data ? counts.data.contacts.toLocaleString('fr-FR') : '—'}</strong></div>
      {counts.isError && <p className="warehouse-error" role="alert">Totaux indisponibles. <Button size="sm" onClick={() => void counts.refetch()}>Réessayer</Button></p>}
    </section>
    <div className="warehouse-categories" aria-label="Catégorie des interlocuteurs">
      <Button variant={onlyToContact ? 'secondary' : 'primary'} aria-pressed={!onlyToContact} onClick={() => { setOnlyToContact(false); setOffset(0) }}>Tous les entrepôts</Button>
      <Button variant={onlyToContact ? 'primary' : 'secondary'} aria-pressed={onlyToContact} onClick={() => { setOnlyToContact(true); setOffset(0) }}>À contacter{counts.data ? ` (${counts.data.to_contact})` : ''}</Button>
    </div>
    <div className="warehouse-toolbar">
      <SearchField label="Rechercher un entrepôt, un propriétaire, un interlocuteur…" value={search} onChange={(value) => { setSearch(value); setOffset(0) }} />
      <span className="warehouse-muted" aria-live="polite">{page ? `${String(page.total)} entrepôt${page.total > 1 ? 's' : ''}` : '—'}</span>
      {search && <Button size="sm" variant="ghost" onClick={() => { setSearch(''); setOffset(0) }}>Réinitialiser</Button>}
    </div>
    {notice && <p className="warehouse-notice" role="status">{notice}</p>}
    {query.isPending && <p role="status" className="warehouse-muted">Chargement des entrepôts…</p>}
    {query.isError && <p role="alert" className="warehouse-error">Impossible de charger les entrepôts. <Button onClick={() => void query.refetch()}>Réessayer</Button></p>}
    {page?.total === 0 && !query.isError && (onlyToContact ? <p className="warehouse-muted">Aucun interlocuteur à contacter ne correspond à cette sélection.</p> : search ? <p className="warehouse-muted">Aucun entrepôt ne correspond à votre recherche.</p> : <EmptyState icon={WarehouseIcon} title="Votre répertoire d’entrepôts" description="Importez votre fichier Excel ou ajoutez votre premier site, puis renseignez ses propriétaires et interlocuteurs." action={<Button variant="primary" icon={PlusIcon} onClick={() => { setEditing(null) }}>Ajouter le premier entrepôt</Button>} />)}
    <div className="warehouse-list">{page?.items.map((warehouse) => <WarehouseRow key={`${warehouse.id}-${String(onlyToContact)}`} warehouse={warehouse} onlyToContact={onlyToContact} onEdit={() => { setEditing(warehouse.id) }} />)}</div>
    {page && page.total > 50 && <nav className="warehouse-pagination" aria-label="Pages des entrepôts"><span>{offset + 1}–{Math.min(offset + page.items.length, page.total)} sur {page.total}</span><Button icon={ChevronLeftIcon} disabled={offset === 0} onClick={() => { setOffset(offset - 50) }}>Précédents</Button><Button icon={ChevronRightIcon} disabled={offset + 50 >= page.total} onClick={() => { setOffset(offset + 50) }}>Suivants</Button></nav>}
    {editing !== undefined && <WarehouseEditor id={editing} onClose={() => { setEditing(undefined) }} />}
    {importing && <WarehouseImport onClose={() => { setImporting(false) }} onImported={(result) => { setImporting(false); setSearch(''); setOffset(0); setNotice(`${String(result.created)} entrepôt(s) ajouté(s), ${String(result.contacts)} interlocuteur(s) importé(s)${result.skipped ? ` · ${String(result.skipped)} entrepôt(s) déjà présent(s)` : ''}.`) }} />}
  </div>
}
