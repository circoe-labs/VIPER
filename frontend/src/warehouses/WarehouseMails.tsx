import { useState } from 'react'
import { Link } from 'react-router'

import { useProspectWarehouseMails, useWarehouseDraftActions, useWarehouseDrafts, type WarehouseDraft } from '../api/warehouses'
import { formatShortDateTime } from '../contact/labels'
import { sendReason } from '../contact/sendReason'
import { identitySentence } from '../identity/identityCopy'
import { EditorSection } from '../prospects/EditorSection'
import { contactHref } from '../prospects/missionMenu/ProspectContactAction'
import { useDebouncedValue } from '../settings/shared'
import { StatusBadge, type StatusTone } from '../ui/Badge'
import { Button } from '../ui/Button'
import { ChevronDownIcon, SpinnerIcon } from '../ui/icons'
import { InfoTip } from '../ui/InfoTip'
import { SearchField } from '../ui/SearchField'
import { Segmented } from '../ui/Segmented'
import { warehouseError } from './WarehouseEditor'
import './warehouses.css'

// The mails of the former warehouse pipeline (`doc/features/warehouses.md`): history, kept readable, plus the ones
// still programmed or to check. Nothing is written or programmed here any more: that is Contact's.

type State = { label: string; tone: StatusTone }

export function mailState(draft: WarehouseDraft): State {
  switch (draft.send_state) {
    case 'sent':
      return { label: 'Envoyé', tone: 'success' }
    case 'scheduled':
      return { label: 'Programmé', tone: 'info' }
    case 'sending':
      return { label: 'Envoi en cours', tone: 'info' }
    case 'uncertain':
      return { label: 'Envoi à vérifier', tone: 'warning' }
    case 'failed':
      return { label: 'Non parti', tone: 'danger' }
    default:
      return { label: 'Jamais envoyé', tone: 'neutral' }
  }
}

// A person settles an unknown send (« sending » too long ago: the server was interrupted).
function toCheck(draft: WarehouseDraft, now: number): boolean {
  if (draft.send_state === 'uncertain') return true
  return draft.send_state === 'sending' && draft.scheduled_at !== null && now - new Date(draft.scheduled_at).getTime() > 15 * 60_000
}

export function MailItem({ draft, now, showPerson = true }: { draft: WarehouseDraft; now: number; showPerson?: boolean }) {
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { unschedule, resolve } = useWarehouseDraftActions()
  const busy = unschedule.isPending || resolve.isPending
  const state = mailState(draft)
  // A mail that never left shows no date: an old proposed one would read as a send.
  const never = draft.send_state === null || draft.send_state === 'planned'
  const moment = never ? null : draft.send_state === 'sent' ? draft.sent_at ?? draft.scheduled_at : draft.send_state === 'failed' ? draft.failed_at : draft.scheduled_at
  const act = (run: () => Promise<unknown>) => {
    setError(null)
    run().catch((caught: unknown) => { setError(warehouseError(caught)) })
  }
  return (
    <li className="warehouse-mail">
      <div className="warehouse-mail__line">
        <button type="button" className="warehouse-mail__toggle" aria-expanded={open} onClick={() => { setOpen(!open) }}>
          <ChevronDownIcon size={16} className={open ? 'warehouse-card__chevron--open' : ''} />
          <span className="warehouse-mail__title">
            <strong>{showPerson ? draft.contact_name : draft.subject}</strong>
            <span className="warehouse-muted">{[draft.warehouse_name, showPerson ? draft.subject : null, draft.recipient].filter(Boolean).join(' · ')}</span>
          </span>
        </button>
        <StatusBadge tone={state.tone}>{state.label}</StatusBadge>
        {moment && <time className="warehouse-muted" dateTime={moment}>{formatShortDateTime(moment)}</time>}
        {draft.prospect_id && showPerson && <Link className="btn btn--ghost btn--sm" to={contactHref(draft.prospect_id)} aria-label={`Contacter ${draft.contact_name}`}>Contacter</Link>}
        {draft.send_state === 'scheduled' && <Button size="sm" loading={unschedule.isPending} disabled={busy} onClick={() => { act(() => unschedule.mutateAsync({ id: draft.id, revision: draft.revision })) }}>Retirer la programmation</Button>}
        {toCheck(draft, now) && <>
          <InfoTip label="Comment vérifier">Regardez les éléments envoyés d’Infomaniak. « Pas parti » ne renvoie rien : écrivez ensuite depuis Contact, après avoir supprimé le brouillon resté dans la boîte.</InfoTip>
          <Button size="sm" disabled={busy} onClick={() => { act(() => resolve.mutateAsync({ id: draft.id, revision: draft.revision, sent: true })) }}>Il est parti</Button>
          <Button size="sm" disabled={busy} onClick={() => { act(() => resolve.mutateAsync({ id: draft.id, revision: draft.revision, sent: false })) }}>Pas parti</Button>
        </>}
      </div>
      {draft.failure_code && <p className="warehouse-muted">{sendReason(draft.failure_code)}</p>}
      {draft.identity_doubt && draft.send_state !== 'sent' && <p className="warehouse-muted">{identitySentence(draft.identity_doubt)}</p>}
      {error && <p className="warehouse-error" role="alert">{error}</p>}
      {open && <div className="warehouse-mail__content"><strong>{draft.subject}</strong><p>{draft.body}</p></div>}
    </li>
  )
}

// The person's warehouse mails on their Contact sheet; nothing when there is none.
export function ProspectWarehouseMails({ prospectId }: { prospectId: string }) {
  const mails = useProspectWarehouseMails(prospectId)
  if (mails.isError) return <p className="warehouse-error" role="alert">Mails entrepôt indisponibles. <Button size="sm" onClick={() => void mails.refetch()}>Réessayer</Button></p>
  if (!mails.data?.length) return null
  return (
    <EditorSection title="Mails entrepôt">
      <ul className="warehouse-mails" aria-label="Mails entrepôt">
        {mails.data.map((draft) => <MailItem key={draft.id} draft={draft} now={mails.dataUpdatedAt} showPerson={false} />)}
      </ul>
    </EditorSection>
  )
}

const FILTERS = [
  { value: 'all', label: 'Tous' },
  { value: 'pending', label: 'En attente ou à vérifier' },
  { value: 'sent', label: 'Envoyés' },
  { value: 'never', label: 'Jamais envoyés' },
] as const
type Filter = (typeof FILTERS)[number]['value']

function matches(draft: WarehouseDraft, filter: Filter): boolean {
  if (filter === 'sent') return draft.send_state === 'sent'
  if (filter === 'pending') return ['scheduled', 'sending', 'uncertain', 'failed'].includes(draft.send_state ?? '')
  if (filter === 'never') return draft.send_state === null || draft.send_state === 'planned'
  return true
}

export function WarehouseMailHistory() {
  const drafts = useWarehouseDrafts()
  const [filter, setFilter] = useState<Filter>('all')
  const [search, setSearch] = useState('')
  const query = useDebouncedValue(search, 250).toLocaleLowerCase('fr')
  if (drafts.isPending) return <p role="status" className="warehouse-muted"><SpinnerIcon size={16} className="btn__spinner" /> Chargement des mails…</p>
  if (drafts.isError) return <p role="alert" className="warehouse-error">Impossible de charger les mails. <Button size="sm" onClick={() => void drafts.refetch()}>Réessayer</Button></p>
  const items = drafts.data.filter((d) => matches(d, filter) && `${d.contact_name} ${d.warehouse_name} ${d.recipient ?? ''} ${d.subject}`.toLocaleLowerCase('fr').includes(query))
  return (
    <section className="warehouse-drafts" aria-label="Anciens mails d’entrepôts">
      <div className="warehouse-toolbar">
        <SearchField label="Rechercher un mail" value={search} onChange={setSearch} />
        <Segmented label="Mails affichés" options={FILTERS.map((f) => ({ value: f.value, label: `${f.label} (${String(drafts.data.filter((d) => matches(d, f.value)).length)})` }))} value={filter} onChange={setFilter} />
      </div>
      {items.length === 0 ? <p className="warehouse-muted">Aucun mail.</p> : <ul className="warehouse-mails">{items.map((draft) => <MailItem key={draft.id} draft={draft} now={drafts.dataUpdatedAt} />)}</ul>}
    </section>
  )
}
