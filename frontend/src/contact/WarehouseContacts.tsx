import { useState } from 'react'
import { Link } from 'react-router'

import { useWarehouseCounts, useWarehouses } from '../api/warehouses'
import { useDebouncedValue } from '../settings/shared'
import { Button } from '../ui/Button'
import { ChevronDownIcon } from '../ui/icons'
import { SearchField } from '../ui/SearchField'

const NUMBER = new Intl.NumberFormat('fr-FR')

export function WarehouseContacts() {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [offset, setOffset] = useState(0)
  const query = useDebouncedValue(search, 250)
  const counts = useWarehouseCounts()
  const sites = useWarehouses(query, offset)
  return <section className="cohort-section contacts-panel" aria-labelledby="warehouse-contacts-title">
    <h2 className="cohort-section__heading" id="warehouse-contacts-title">
      <button type="button" className="cohort-section__toggle" aria-expanded={open} aria-controls="warehouse-contacts-list" onClick={() => setOpen(!open)}>
        <span className="cohort-section__name"><ChevronDownIcon size={18} className="cohort-section__arrow" /><span className="cohort-section__code">Prospects entrepôt</span><span className="cohort-section__count">{counts.data ? `${NUMBER.format(counts.data.contacts)} interlocuteurs` : '–'}</span></span>
      </button>
    </h2>
    {open && <div id="warehouse-contacts-list" className="cohort-section__body warehouse-contact-list">
      <p>Interlocuteurs du répertoire d’entrepôts. Leurs coordonnées sont à vérifier avant contact.</p>
      <SearchField label="Rechercher un prospect ou un entrepôt" value={search} onChange={(value) => { setSearch(value); setOffset(0) }} />
      {sites.isPending && <p role="status">Chargement des prospects entrepôt…</p>}
      {sites.isError && <p role="alert">Liste indisponible. <Button size="sm" onClick={() => void sites.refetch()}>Réessayer</Button></p>}
      {sites.data?.total === 0 && <p>Aucun entrepôt ne correspond à la recherche.</p>}
      {sites.data?.items.map((site) => <section className="warehouse-contact-list__site" key={site.id}>
        <h3>{site.name}{site.city ? ` · ${site.city}` : ''}</h3>
        {site.contacts.length ? <ul>{site.contacts.map((person, index) => <li key={index}><strong>{person.full_name}</strong>{person.role && <span>{person.role}</span>}{person.email && <span>{person.email}</span>}</li>)}</ul> : <p>Aucun interlocuteur renseigné.</p>}
      </section>)}
      {sites.data && sites.data.total > 50 && <nav className="contact-pagination" aria-label="Pagination des entrepôts">
        <Button size="sm" disabled={offset === 0 || sites.isFetching} onClick={() => setOffset(Math.max(0, offset - 50))}>Précédents</Button>
        <span>{offset + 1}–{Math.min(offset + 50, sites.data.total)} sur {sites.data.total} entrepôts</span>
        <Button size="sm" disabled={offset + 50 >= sites.data.total || sites.isFetching} onClick={() => setOffset(offset + 50)}>Suivants</Button>
      </nav>}
      <Link to="/warehouses">Gérer les fiches d’entrepôt</Link>
    </div>}
  </section>
}
