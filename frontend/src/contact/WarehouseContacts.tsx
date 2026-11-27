import { useState } from 'react'
import { Link } from 'react-router'

import { useWarehouseDrafts, type WarehouseDraft } from '../api/warehouses'
import { useDebouncedValue } from '../settings/shared'
import { StatusBadge, type StatusTone } from '../ui/Badge'
import { Button } from '../ui/Button'
import { ChevronDownIcon } from '../ui/icons'
import { SearchField } from '../ui/SearchField'
import { formatShortDateTime } from './labels'
import { sendReason } from './sendReason'
import './send-status.css'

const NUMBER = new Intl.NumberFormat('fr-FR')

// A warehouse mail that was given a send moment and has not (certainly) left: it stays listed until it is sent or its
// scheduling is removed, whatever the day.
function situation(draft: WarehouseDraft, now: number): { label: string; tone: StatusTone; problem: boolean } | null {
  switch (draft.send_state) {
    case 'failed':
      return { label: 'Non parti', tone: 'danger', problem: true }
    case 'uncertain':
      return { label: 'Envoi à vérifier', tone: 'warning', problem: true }
    case 'sending':
      return { label: 'Envoi en cours', tone: 'info', problem: false }
    case 'scheduled':
      return draft.scheduled_at && new Date(draft.scheduled_at).getTime() < now
        ? { label: 'Heure passée, pas encore parti', tone: 'warning', problem: true }
        : { label: 'Programmé', tone: 'info', problem: false }
    case 'planned':
      return { label: 'Préprogrammé, à valider', tone: 'warning', problem: false }
    default:
      return null
  }
}

export function WarehouseContacts() {
  const [chosen, setOpen] = useState<boolean | null>(null)
  const [search, setSearch] = useState('')
  const query = useDebouncedValue(search, 250)
  const drafts = useWarehouseDrafts()
  const now = drafts.dataUpdatedAt
  const pending = (drafts.data ?? [])
    .flatMap((draft) => {
      const state = situation(draft, now)
      return state ? [{ draft, state }] : []
    })
    .sort(
      (a, b) =>
        Number(b.state.problem) - Number(a.state.problem) ||
        (a.draft.scheduled_at ?? '').localeCompare(b.draft.scheduled_at ?? ''),
    )
  const problems = pending.filter((entry) => entry.state.problem).length
  // A failure opens the section by itself; the person's own choice wins.
  const open = chosen ?? problems > 0
  const matching = pending.filter(({ draft }) => `${draft.contact_name} ${draft.warehouse_name} ${draft.contact_role ?? ''} ${draft.recipient ?? ''}`.toLocaleLowerCase('fr').includes(query.toLocaleLowerCase('fr')))
  const bySite = matching.reduce<Map<string, typeof matching>>((groups, entry) => {
    const items = groups.get(entry.draft.warehouse_name) ?? []
    items.push(entry)
    groups.set(entry.draft.warehouse_name, items)
    return groups
  }, new Map())

  return <section className="cohort-section contacts-panel" aria-labelledby="warehouse-contacts-title">
    <h2 className="cohort-section__heading" id="warehouse-contacts-title">
      <button type="button" className="cohort-section__toggle" aria-expanded={open} aria-controls="warehouse-contacts-list" onClick={() => { setOpen(!open) }}>
        <span className="cohort-section__name"><ChevronDownIcon size={18} className="cohort-section__arrow" /><span className="cohort-section__code">Prospects entrepôt</span><span className="cohort-section__count">{drafts.data ? `${NUMBER.format(pending.length)} en attente d’envoi` : '–'}</span>{problems > 0 && <StatusBadge tone="danger">{NUMBER.format(problems)} à reprendre</StatusBadge>}</span>
      </button>
    </h2>
    {open && <div id="warehouse-contacts-list" className="cohort-section__body warehouse-contact-list">
      <SearchField label="Rechercher un prospect ou un entrepôt" value={search} onChange={setSearch} />
      {drafts.isPending && <p role="status">Chargement des programmations…</p>}
      {drafts.isError && <p role="alert">Liste indisponible. <Button size="sm" onClick={() => void drafts.refetch()}>Réessayer</Button></p>}
      {drafts.data && pending.length === 0 && <p>Aucun mail d’entrepôt en attente d’envoi.</p>}
      {pending.length > 0 && matching.length === 0 && <p>Aucun prospect ne correspond à la recherche.</p>}
      {Array.from(bySite, ([site, items]) => <section className="warehouse-contact-list__site" key={site}>
        <h3>{site}</h3>
        <ul>{items.map(({ draft, state }) => <li key={draft.id}>
          <strong>{draft.contact_name}</strong>
          {draft.contact_role && <span>{draft.contact_role}</span>}
          {draft.recipient && <span>{draft.recipient}</span>}
          <StatusBadge tone={state.tone}>{state.label}</StatusBadge>
          {draft.scheduled_at && <span>{state.problem ? 'Prévu le ' : ''}<time dateTime={draft.scheduled_at}>{formatShortDateTime(draft.scheduled_at)}</time></span>}
          {draft.failure_code && <span>{sendReason(draft.failure_code)}{draft.failed_at ? ` (le ${formatShortDateTime(draft.failed_at)})` : ''}</span>}
        </li>)}</ul>
      </section>)}
      <Link to="/prospection?entity=warehouse">Gérer les fiches d’entrepôt</Link>
    </div>}
  </section>
}
