import { FILE_STATUS_LABELS, FILE_STATUS_TONES, missingText } from '../api/fileStatus'
import { StatusBadge } from '../ui/Badge'
import { useState } from 'react'
import { useWarehousePeople, useWarehouseWrites, type Warehouse, type WarehouseContact, type WarehousePerson } from '../api/warehouses'
import { Button } from '../ui/Button'
import { BuildingIcon, ChevronDownIcon, MapPinIcon, PencilIcon, SpinnerIcon, WarehouseIcon } from '../ui/icons'
import { useRowMenu } from '../ui/RowMenu'
import { PageHeader } from '../ui/PageHeader'
import { warehouseError } from './WarehouseEditor'
import { WarehouseMailHistory } from './WarehouseMails'
import { WarehousePersonContact } from './WarehousePersonContact'
import '../prospection/prospection.css'
import './warehouses.css'

// The source role is free text; keep the original order when no priority can be inferred.
function contactPriority(contact: WarehouseContact): number {
  const role = (contact.role ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  if (/\b(directeur|directrice)\b/.test(role)) return 0
  if (/logistique/.test(role) && /\b(gerant|gerante|responsable|gestionnaire|manager|chef|cheffe)\b/.test(role)) return 1
  return 2
}

// The listing's name as the server compares it: words without civility, accents, case or order.
const CIVILITIES = new Set(['m', 'mr', 'mme', 'mlle', 'dr', 'monsieur', 'madame', 'mademoiselle'])
function personKey(name: string): string {
  return name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().split(/[^0-9a-z]+/).filter((word) => word && !CIVILITIES.has(word)).sort().join(' ')
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
  const people = useWarehousePeople(warehouse.id, open)
  function contactLine(name: string, kind: WarehousePerson['kind']) {
    const key = personKey(name)
    const found = people.data?.people.find((p) => p.kind === kind && personKey(p.contact_name) === key)
      ?? people.data?.people.find((p) => personKey(p.contact_name) === key)
    return found && people.data ? <WarehousePersonContact warehouseId={warehouse.id} person={found} company={people.data} /> : null
  }
  const rowMenu = useRowMenu<Warehouse>(
    (site) => `Actions de ${site.name}`,
    () => [
      { id: 'edit', label: 'Modifier', icon: PencilIcon, onSelect: onEdit },
      { id: 'details', label: open ? 'Masquer les détails' : 'Afficher les détails', icon: ChevronDownIcon, onSelect: () => { setOpen(!open) } },
    ],
  )
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
  return <article className="warehouse-card" onContextMenu={rowMenu.onContextMenu(warehouse)}>
    <div className="warehouse-card__header">
      <button className="warehouse-card__toggle" type="button" aria-label={`Détails de ${warehouse.name}`} aria-expanded={open} aria-controls={`warehouse-${warehouse.id}`} onClick={() => { setOpen(!open) }}>
        <ChevronDownIcon className={open ? 'warehouse-card__chevron--open' : ''} size={26} />
        <span className="warehouse-card__icon"><WarehouseIcon size={22} /></span>
        <span className="warehouse-card__identity"><strong>{warehouse.name}</strong>
          <span><StatusBadge tone={FILE_STATUS_TONES[warehouse.status]}>{FILE_STATUS_LABELS[warehouse.status]}</StatusBadge>{warehouse.missing.length > 0 && <span className="warehouse-muted"> Manque : {missingText(warehouse.missing)}</span>}</span>
          <span className={warehouse.company_name ? 'warehouse-card__owner' : 'warehouse-card__owner warehouse-card__owner--missing'}><BuildingIcon size={14} />{warehouse.company_name ? <><span className="warehouse-card__owner-label">Société</span> {warehouse.company_name}{warehouse.building_name ? ` · ${warehouse.building_name}` : ''}</> : 'Rattacher à un bâtiment d’une société'}</span>
          <span>{warehouse.contacts.length} interlocuteur{warehouse.contacts.length > 1 ? 's' : ''}{warehouse.city ? ` · ${warehouse.city}` : ''} · {warehouse.prospecting_category === 'sme' ? 'PME/TPE' : warehouse.prospecting_category === 'other' ? 'Autres' : 'À classer'}</span></span>
      </button>
      <Button size="sm" onClick={onEdit} aria-label={`Modifier ${warehouse.name}`}>Modifier</Button>
      {rowMenu.button(warehouse)}
    </div>
    <div id={`warehouse-${warehouse.id}`} hidden={!open} className="warehouse-card__details">
      <section className="warehouse-owner" aria-label={`Propriétaire de ${warehouse.name}`}>
        <h3><BuildingIcon size={16} /> Société rattachée (propriétaire)</h3>
        {warehouse.company_name && <p><strong>{warehouse.company_name}</strong>{warehouse.building_name && <span> · {warehouse.building_name}</span>}</p>}
        {warehouse.owner_name ? <p><strong>{warehouse.owner_name}</strong>{warehouse.owner_role && <span> · {warehouse.owner_role}</span>}</p> : !warehouse.company_name && <p className="warehouse-muted">Société rattachée à renseigner</p>}
        {warehouse.owner_email && <p className="warehouse-contact-email"><strong>E-mail : </strong>{warehouse.owner_email}</p>}
        <LinkedIn url={warehouse.owner_linkedin} />
        {warehouse.owner_name && contactLine(warehouse.owner_name, 'owner')}
      </section>
      {(warehouse.address || warehouse.city || warehouse.siret) && <div className="warehouse-address">
        <MapPinIcon size={17} /><p>{[warehouse.address, warehouse.postal_code, warehouse.city].filter(Boolean).join(' · ')}{warehouse.siret && <span>SIRET : {warehouse.siret}</span>}</p>
      </div>}
      <h3>Interlocuteurs à contacter</h3>
      <p className="warehouse-muted">Coordonnées à vérifier avant contact.</p>
      {open && people.isPending && <p role="status" className="warehouse-muted"><SpinnerIcon size={16} className="btn__spinner" /> Chargement de l’état de contact…</p>}
      {people.isError && <p role="alert" className="warehouse-error">État de contact indisponible. <Button size="sm" onClick={() => void people.refetch()}>Réessayer</Button></p>}
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
          {contactLine(contact.full_name, 'contact')}
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
    {rowMenu.menu}
  </article>
}

// « Mails d’entrepôts » (`/prospection/warehouse-drafts`): the history of the former warehouse mails and the ones
// still programmed. New messages are written from Contact, person by person.
export function WarehouseDraftsPage() {
  return <div className="warehouses-page">
    <PageHeader mascot="build" back={{ to: '/prospection?entity=warehouse', label: 'Entrepôts' }} title="Mails d’entrepôts" description="Anciens messages des entrepôts. Les nouveaux s’écrivent depuis Contact." />
    <WarehouseMailHistory />
  </div>
}
