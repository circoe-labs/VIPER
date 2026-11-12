import { useState } from 'react'
import { Link } from 'react-router'

import { useWarehouseDrafts } from '../api/warehouses'
import { useDebouncedValue } from '../settings/shared'
import { Button } from '../ui/Button'
import { ChevronDownIcon } from '../ui/icons'
import { SearchField } from '../ui/SearchField'

const NUMBER = new Intl.NumberFormat('fr-FR')
const DATE = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'long', timeStyle: 'short' })

function tomorrowParis() {
  const tomorrow = new Date()
  tomorrow.setDate(tomorrow.getDate() + 1)
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' }).format(tomorrow)
}

export function WarehouseContacts() {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const query = useDebouncedValue(search, 250)
  const drafts = useWarehouseDrafts()
  const plannedForTomorrow = (drafts.data ?? []).filter((draft) => draft.send_state === 'scheduled' && draft.scheduled_at && new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(draft.scheduled_at)) === tomorrowParis())
  const matching = plannedForTomorrow.filter((draft) => `${draft.contact_name} ${draft.warehouse_name} ${draft.contact_role ?? ''} ${draft.recipient ?? ''}`.toLocaleLowerCase('fr').includes(query.toLocaleLowerCase('fr')))
  const bySite = matching.reduce<Map<string, typeof matching>>((groups, draft) => {
    const items = groups.get(draft.warehouse_name) ?? []
    items.push(draft)
    groups.set(draft.warehouse_name, items)
    return groups
  }, new Map())

  return <section className="cohort-section contacts-panel" aria-labelledby="warehouse-contacts-title">
    <h2 className="cohort-section__heading" id="warehouse-contacts-title">
      <button type="button" className="cohort-section__toggle" aria-expanded={open} aria-controls="warehouse-contacts-list" onClick={() => setOpen(!open)}>
        <span className="cohort-section__name"><ChevronDownIcon size={18} className="cohort-section__arrow" /><span className="cohort-section__code">Prospects entrepôt</span><span className="cohort-section__count">{drafts.data ? `${NUMBER.format(plannedForTomorrow.length)} prévus demain` : '–'}</span></span>
      </button>
    </h2>
    {open && <div id="warehouse-contacts-list" className="cohort-section__body warehouse-contact-list">
      <p>Prospects dont le mail est validé et programmé demain. Les brouillons en attente de validation ne figurent pas dans cette liste.</p>
      <SearchField label="Rechercher un prospect ou un entrepôt" value={search} onChange={setSearch} />
      {drafts.isPending && <p role="status">Chargement des programmations…</p>}
      {drafts.isError && <p role="alert">Liste indisponible. <Button size="sm" onClick={() => void drafts.refetch()}>Réessayer</Button></p>}
      {drafts.data && plannedForTomorrow.length === 0 && <p>Aucun mail d’entrepôt programmé pour demain.</p>}
      {drafts.data && plannedForTomorrow.length > 0 && matching.length === 0 && <p>Aucun prospect ne correspond à la recherche.</p>}
      {Array.from(bySite, ([site, items]) => <section className="warehouse-contact-list__site" key={site}>
        <h3>{site}</h3>
        <ul>{items.map((draft) => <li key={draft.id}><strong>{draft.contact_name}</strong>{draft.contact_role && <span>{draft.contact_role}</span>}{draft.recipient && <span>{draft.recipient}</span>}{draft.scheduled_at && <span>{DATE.format(new Date(draft.scheduled_at))}</span>}</li>)}</ul>
      </section>)}
      <Link to="/warehouses">Gérer les fiches d’entrepôt</Link>
    </div>}
  </section>
}
