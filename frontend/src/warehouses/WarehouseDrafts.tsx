import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError } from '../api/client'
import { type WarehouseDraft, useWarehouseDispatchStatus, useWarehouseDraftActions, useWarehouseDrafts } from '../api/warehouses'
import { Button, IconButton } from '../ui/Button'
import { TextAreaField, TextField } from '../ui/fields'
import { ChevronDownIcon, ChevronLeftIcon, ChevronRightIcon } from '../ui/icons'

function localDateTimeValue(iso: string): string {
  const date = new Date(iso)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function belongsToGroup(item: WarehouseDraft, group: string): boolean {
  if (group === 'sans-date') return !item.scheduled_at && !['sending', 'uncertain', 'sent'].includes(item.send_state ?? '')
  return (item.send_state === 'planned' || item.send_state === 'scheduled') && item.scheduled_at !== null && new Date(item.scheduled_at).getTime() === new Date(group).getTime()
}

function DraftCard({ draft, dispatchActive, open, onToggle, onMove, onValidated, onDirtyChange, position, total }: {
  draft: WarehouseDraft; dispatchActive: boolean; open: boolean; onToggle: () => void
  onMove: (direction: -1 | 1) => void; onValidated: () => void; position: number; total: number
  onDirtyChange: (id: string, dirty: boolean) => void
}) {
  const [recipient, setRecipient] = useState(draft.recipient ?? '')
  const [subject, setSubject] = useState(draft.subject)
  const [body, setBody] = useState(draft.body)
  const [baseline, setBaseline] = useState(draft)
  const [error, setError] = useState('')
  const actions = useWarehouseDraftActions()
  const dirty = recipient !== (baseline.recipient ?? '') || subject !== baseline.subject || body !== baseline.body
  useEffect(() => { onDirtyChange(draft.id, dirty) }, [draft.id, dirty, onDirtyChange])
  if (draft.revision !== baseline.revision && !dirty) {
    setBaseline(draft)
    setRecipient(draft.recipient ?? '')
    setSubject(draft.subject)
    setBody(draft.body)
  }
  const busy = actions.save.isPending || actions.validate.isPending || actions.schedule.isPending || actions.unschedule.isPending
  const locked = ['sending', 'uncertain', 'sent'].includes(draft.send_state ?? '')
  const valid = Boolean(draft.validated_at) && !dirty
  const humanReviewed = draft.human_validated === true && !dirty
  async function save() {
    setError('')
    try {
      const saved = await actions.save.mutateAsync({ id: draft.id, revision: draft.revision, recipient, subject, body })
      setBaseline(saved)
      setRecipient(saved.recipient ?? '')
      setSubject(saved.subject)
      setBody(saved.body)
    }
    catch { setError('Enregistrement impossible. Vérifiez les champs ou rechargez la page si le brouillon a changé.') }
  }
  async function validate() {
    setError('')
    try {
      const current = dirty ? await actions.save.mutateAsync({ id: draft.id, revision: draft.revision, recipient, subject, body }) : draft
      if (dirty) { setBaseline(current); setRecipient(current.recipient ?? ''); setSubject(current.subject); setBody(current.body) }
      await actions.validate.mutateAsync({ id: draft.id, revision: current.revision })
      onDirtyChange(draft.id, false)
      onValidated()
    }
    catch (error) {
      const detail = error instanceof ApiError ? error.detail : undefined
      const message = typeof detail === 'object' && detail !== null ? (detail as { message?: unknown }).message : detail
      const reason = typeof message === 'string' ? message : ''
      setError(reason ? `Validation impossible. ${reason}` : 'Validation impossible. Vérifiez la date, l’adresse, la civilité, le nom, l’entreprise, la fonction et la mention DIHNAMO.')
    }
  }
  async function unschedule() {
    setError('')
    try { await actions.unschedule.mutateAsync({ id: draft.id, revision: draft.revision }) }
    catch { setError('Impossible de retirer la programmation. Rechargez pour vérifier son état.') }
  }
  const sourceAddresses = [...new Set(draft.source_email?.match(/[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)+/g) ?? [])]
  const mailto = `mailto:${encodeURIComponent(draft.recipient ?? '')}?subject=${encodeURIComponent(draft.subject)}&body=${encodeURIComponent(draft.body)}`
  return <details className={`warehouse-draft${humanReviewed ? ' warehouse-draft--confirmed' : ''}`} open={open}>
    <summary id={`warehouse-draft-${draft.id}`} onClick={(event) => { event.preventDefault(); onToggle() }}><ChevronDownIcon className="warehouse-draft__chevron" size={18} /><span><strong>{draft.contact_name}</strong><small>{draft.warehouse_name}{draft.contact_role ? ` · ${draft.contact_role}` : ''}</small><small>{draft.recipient || 'Destinataire à choisir'}</small></span><span className="warehouse-draft__badge">{humanReviewed ? 'Validé manuellement' : 'À valider'}{draft.send_state === 'planned' ? ' · Préprogrammé' : draft.send_state === 'scheduled' ? ' · Programmé' : draft.send_state === 'sent' ? ' · Envoyé' : draft.send_state === 'sending' || draft.send_state === 'uncertain' ? ' · Envoi à vérifier' : draft.send_state === 'failed' ? ' · Envoi non effectué' : ''}</span></summary>
    <div className="warehouse-draft__content">
      <p><strong>Adresse source : </strong>{draft.source_email || 'Non renseignée'}</p>
      <p className="warehouse-draft__note">{draft.review_note}</p>
      <TextField label="Destinataire" type="email" value={recipient} disabled={locked} onChange={(e) => setRecipient(e.target.value)} hint="Choisissez et vérifiez une seule adresse." />
      {!locked && sourceAddresses.length > 1 && <div className="warehouse-draft__source-addresses" aria-label="Adresses proposées">
        <span>Choisir une adresse source :</span>
        {sourceAddresses.map((address) => <Button key={address} size="sm" variant="secondary" onClick={() => setRecipient(address)}>{address}</Button>)}
      </div>}
      <TextField label="Objet" value={subject} disabled={locked} onChange={(e) => setSubject(e.target.value)} />
      <TextAreaField label="Message" rows={12} value={body} disabled={locked} onChange={(e) => setBody(e.target.value)} />
      {draft.send_state === 'planned' && <p>Ce brouillon est préprogrammé pour le {draft.scheduled_at && new Intl.DateTimeFormat('fr-FR', { dateStyle: 'long', timeStyle: 'short' }).format(new Date(draft.scheduled_at))}. Sa validation autorise son envoi à cette date.</p>}
      {draft.send_state === 'scheduled' && draft.scheduled_at && <p>Programmé pour le {new Intl.DateTimeFormat('fr-FR', { dateStyle: 'long', timeStyle: 'short' }).format(new Date(draft.scheduled_at))}.</p>}
      {draft.send_state === 'scheduled' && <p>Une modification enregistrée remettra ce message en attente de validation.</p>}
      {(draft.send_state === 'uncertain' || draft.send_state === 'sending') && <p role="alert">L’envoi n’est pas confirmé. Vérifiez la messagerie avant toute nouvelle tentative.</p>}
      {draft.send_state === 'failed' && <p role="alert">Envoi non effectué : vérifiez les paramètres d’envoi et l’adresse avant de reprogrammer.</p>}
      {!dispatchActive && draft.send_state !== 'sent' && <p role="status">L’envoi automatique est inactif : ce message ne partira pas tant qu’il ne sera pas activé et que la Toolbox ne sera pas connectée.</p>}
      {error && <p className="warehouse-error" role="alert">{error}</p>}
      <div className="warehouse-draft__actions">
        {!locked && <Button disabled={!dirty || busy} onClick={() => void save()}>Enregistrer</Button>}
        {!locked && <Button disabled={busy || !recipient || !['planned', 'scheduled'].includes(draft.send_state ?? '')} onClick={() => void validate()}>Validé et continuer</Button>}
        {(draft.send_state === 'scheduled' || draft.send_state === 'planned') && <Button disabled={busy} onClick={() => void unschedule()}>Retirer la programmation</Button>}
        {valid && !locked && draft.send_state !== 'scheduled' && <a className="btn btn--secondary btn--md" href={mailto}>Ouvrir dans la messagerie</a>}
      </div>
      <p className="warehouse-muted">{humanReviewed ? 'Validé manuellement. ' : 'Pas encore validé manuellement. '}La programmation utilise la connexion et les paramètres d’envoi de VIPER.</p>
      <nav className="warehouse-draft__navigation" aria-label="Navigation entre les brouillons">
        <span>{position} / {total}</span>
        <IconButton icon={ChevronLeftIcon} label="Brouillon précédent" variant="secondary" disabled={position === 1 || busy} onClick={() => onMove(-1)} />
        <IconButton icon={ChevronRightIcon} label="Brouillon suivant" variant="secondary" disabled={position === total || busy} onClick={() => onMove(1)} />
      </nav>
    </div>
  </details>
}

export function WarehouseDrafts({ category }: { category: 'sme' | 'other' | 'unclassified' }) {
  const drafts = useWarehouseDrafts()
  const dispatch = useWarehouseDispatchStatus()
  const actions = useWarehouseDraftActions()
  const [batchWhen, setBatchWhen] = useState<string | null>(null)
  const [batchError, setBatchError] = useState('')
  const [batchSuccess, setBatchSuccess] = useState('')
  const [recoveryWhen, setRecoveryWhen] = useState('')
  const [recoveryConfirmed, setRecoveryConfirmed] = useState(false)
  const [recoveryError, setRecoveryError] = useState('')
  const [recoverySuccess, setRecoverySuccess] = useState('')
  const [openDraft, setOpenDraft] = useState<string | null>(null)
  const [reviewSchedule, setReviewSchedule] = useState<string | null>(null)
  const scrollTarget = useRef<string | null>(null)
  const [validationNotice, setValidationNotice] = useState('')
  const [dirtyDrafts, setDirtyDrafts] = useState<Set<string>>(() => new Set())
  const onDirtyChange = useCallback((id: string, dirty: boolean) => {
    setDirtyDrafts((current) => {
      if (current.has(id) === dirty) return current
      const next = new Set(current)
      if (dirty) next.add(id); else next.delete(id)
      return next
    })
  }, [])
  useEffect(() => {
    if (!openDraft || scrollTarget.current !== openDraft) return
    const frame = requestAnimationFrame(() => {
      const summary = document.getElementById(`warehouse-draft-${openDraft}`)
      summary?.scrollIntoView?.({ block: 'start', behavior: 'smooth' })
      summary?.focus({ preventScroll: true })
      scrollTarget.current = null
    })
    return () => cancelAnimationFrame(frame)
  }, [openDraft, reviewSchedule])
  if (drafts.isPending) return <p role="status" className="warehouse-muted">Chargement des brouillons…</p>
  if (drafts.isError) return <p role="alert" className="warehouse-error">Impossible de charger les brouillons. <Button size="sm" onClick={() => void drafts.refetch()}>Réessayer</Button></p>
  const allItems = drafts.data.filter((draft) => category === 'unclassified' ? !draft.prospecting_category : draft.prospecting_category === category)
  const items = reviewSchedule ? allItems.filter((item) => belongsToGroup(item, reviewSchedule)) : allItems
  const eligible = drafts.data.filter((draft) => [null, 'planned', 'scheduled', 'failed'].includes(draft.send_state))
  const scheduled = allItems.filter((draft) => ['planned', 'scheduled'].includes(draft.send_state ?? '') && draft.scheduled_at)
  const scheduledGroups = new Map<string, number>()
  for (const draft of scheduled) {
    const at = new Date(draft.scheduled_at!).getTime()
    if (!Number.isFinite(at)) continue
    const key = new Date(at).toISOString()
    scheduledGroups.set(key, (scheduledGroups.get(key) ?? 0) + 1)
  }
  const scheduledDate = scheduledGroups.size === 1 ? localDateTimeValue([...scheduledGroups.keys()][0]!) : ''
  const batchDate = batchWhen ?? scheduledDate
  const recoveryEligible = allItems.filter((draft) => draft.recovery_possible)
  function moveDraft(index: number) {
    const target = items[index]
    if (!target) return
    if (target.id === openDraft) {
      const summary = document.getElementById(`warehouse-draft-${target.id}`)
      summary?.scrollIntoView?.({ block: 'start', behavior: 'smooth' })
      summary?.focus({ preventScroll: true })
      return
    }
    scrollTarget.current = target.id
    setOpenDraft(target.id)
  }
  function openScheduledGroup(at: string) {
    const group = allItems.filter((item) => belongsToGroup(item, at))
    const target = group.find((item) => !item.human_validated) ?? group[0]
    if (!target) return
    scrollTarget.current = target.id
    setReviewSchedule(at)
    setValidationNotice('')
    setOpenDraft(target.id)
  }
  function moveAfterValidation(index: number) {
    const next = items.findIndex((item, position) => position > index && !item.human_validated && !['sending', 'uncertain', 'sent'].includes(item.send_state ?? ''))
    if (next < 0) {
      setValidationNotice(reviewSchedule ? 'Message validé. Il n’y a plus de message suivant à vérifier pour cette date.' : 'Message validé. Il n’y a plus de message suivant à vérifier dans cette liste.')
      return
    }
    setValidationNotice('')
    moveDraft(next)
  }
  async function scheduleAll() {
    setBatchError('')
    setBatchSuccess('')
    const at = new Date(batchDate)
    if (!batchDate || !Number.isFinite(at.getTime()) || at.getTime() <= Date.now()) { setBatchError('Choisissez une date et une heure futures.'); return }
    try {
      const result = await actions.planBatch.mutateAsync({ scheduled_at: at.toISOString(), drafts: eligible.map(({ id, revision }) => ({ id, revision })) })
      setBatchSuccess(`${String(result.scheduled)} messages préprogrammés. Validez chaque message pour autoriser son envoi.`)
    } catch { setBatchError('Programmation groupée impossible. Rechargez la liste et vérifiez les destinataires et les messages.') }
  }
  async function recoverAll() {
    setRecoveryError('')
    setRecoverySuccess('')
    const at = new Date(recoveryWhen)
    if (!recoveryConfirmed) { setRecoveryError('Confirmez d’abord la vérification de la boîte Infomaniak.'); return }
    if (!recoveryWhen || !Number.isFinite(at.getTime()) || at.getTime() <= Date.now()) { setRecoveryError('Choisissez une date et une heure futures.'); return }
    if (!window.confirm(`Reprogrammer ${String(recoveryEligible.length)} messages pour le ${new Intl.DateTimeFormat('fr-FR', { dateStyle: 'long', timeStyle: 'short' }).format(at)} ? Vous confirmez qu’aucun n’apparaît dans Envoyés ni dans Brouillons Infomaniak.`)) return
    try {
      const result = await actions.recoverBatch.mutateAsync({
        scheduled_at: at.toISOString(),
        confirmed_not_sent: true,
        drafts: recoveryEligible.map(({ id, revision }) => ({ id, revision })),
      })
      setRecoverySuccess(`${String(result.scheduled)} messages reprogrammés. Leur validation et leur contenu sont conservés.`)
      setRecoveryConfirmed(false)
    } catch { setRecoveryError('Reprogrammation impossible. Rechargez la liste : un message a peut-être changé depuis la vérification.') }
  }
  return <section className="warehouse-drafts" aria-labelledby="warehouse-drafts-title">
    <div><h2 id="warehouse-drafts-title">{reviewSchedule ? reviewSchedule === 'sans-date' ? `Brouillons sans date (${items.length})` : `Brouillons du ${new Intl.DateTimeFormat('fr-FR', { dateStyle: 'long', timeStyle: 'short' }).format(new Date(reviewSchedule))} (${items.length})` : `Brouillons à vérifier (${allItems.length})`}</h2><p className="warehouse-muted">Vérifiez les destinataires et les messages, puis enregistrez vos modifications avant la programmation groupée.</p></div>
    {reviewSchedule ? <div><Button icon={ChevronLeftIcon} disabled={dirtyDrafts.size > 0} onClick={() => { setReviewSchedule(null); setOpenDraft(null); setValidationNotice('') }}>Retour aux sous-brouillons</Button>{dirtyDrafts.size > 0 && <p className="warehouse-muted">Enregistrez vos modifications avant de revenir aux sous-brouillons.</p>}</div> : <div className="warehouse-draft__content warehouse-draft">
      <h3>Programmation groupée</h3>
      {[...scheduledGroups].sort(([a], [b]) => a.localeCompare(b)).map(([at, count]) => {
        const date = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'long', timeStyle: 'short' }).format(new Date(at))
        const remaining = allItems.filter((item) => belongsToGroup(item, at) && !item.human_validated).length
        return <div key={at} className="warehouse-scheduled-group"><p><strong>{count} message{count > 1 ? 's' : ''} programmé{count > 1 ? 's' : ''}</strong> pour le {date} · {remaining} à valider.</p><Button size="sm" icon={ChevronRightIcon} disabled={dirtyDrafts.size > 0} onClick={() => openScheduledGroup(at)} aria-label={`Voir les messages du ${date}`}>Brouillons du {date} ({count})</Button></div>
      })}
      {allItems.some((item) => belongsToGroup(item, 'sans-date')) && <div><Button size="sm" icon={ChevronRightIcon} disabled={dirtyDrafts.size > 0} onClick={() => openScheduledGroup('sans-date')}>Brouillons sans date ({allItems.filter((item) => belongsToGroup(item, 'sans-date')).length})</Button></div>}
      <p>{eligible.length} messages des deux catégories disponibles pour une date commune.</p>
      {!dispatch.data?.active && <p role="status">L’envoi automatique est inactif : les messages ne partiront pas tant qu’il ne sera pas activé et que la Toolbox ne sera pas connectée.</p>}
      <details><summary>Voir les destinataires et objets à programmer</summary><ul>{eligible.map((draft) => <li key={draft.id}>{draft.contact_name} — {draft.recipient} — {draft.subject}</li>)}</ul></details>
      <TextField label="Date et heure pour tous les messages" type="datetime-local" value={batchDate} onChange={(e) => setBatchWhen(e.target.value)} />
      <div><Button variant="primary" disabled={!batchDate || eligible.length === 0 || dirtyDrafts.size > 0 || actions.planBatch.isPending} onClick={() => void scheduleAll()}>Préprogrammer tous les messages</Button></div>
      {dirtyDrafts.size > 0 && <p className="warehouse-muted">Enregistrez les modifications en cours avant de programmer les messages.</p>}
      <p className="warehouse-muted">La date est commune à tous les brouillons. Une nouvelle préprogrammation retire les validations précédentes ; chaque message doit ensuite être validé pour autoriser son envoi.</p>
      {batchError && <p role="alert" className="warehouse-error">{batchError}</p>}
      {batchSuccess && <p role="status">{batchSuccess}</p>}
    </div>}
    {!reviewSchedule && recoveryEligible.length > 0 && <div className="warehouse-draft__content warehouse-draft">
      <h3>Reprogrammer les envois à vérifier</h3>
      <p>{recoveryEligible.length} messages déjà validés peuvent être repris. Vérifiez dans Infomaniak qu’ils ne figurent ni dans Envoyés ni dans Brouillons. La Toolbox doit être rétablie avant l’heure choisie.</p>
      <details><summary>Voir les destinataires et objets concernés</summary><ul>{recoveryEligible.map((draft) => <li key={draft.id}>{draft.contact_name} — {draft.recipient} — {draft.subject}</li>)}</ul></details>
      <label className="warehouse-recovery-confirm"><input type="checkbox" checked={recoveryConfirmed} onChange={(event) => setRecoveryConfirmed(event.target.checked)} /> J’ai vérifié la boîte Infomaniak : aucun de ces messages n’apparaît dans Envoyés ni dans Brouillons.</label>
      <TextField label="Nouvelle date et heure pour tous les messages" type="datetime-local" value={recoveryWhen} onChange={(event) => setRecoveryWhen(event.target.value)} />
      <div><Button variant="primary" disabled={!recoveryConfirmed || !recoveryWhen || actions.recoverBatch.isPending} onClick={() => void recoverAll()}>Reprogrammer les messages vérifiés</Button></div>
      {recoveryError && <p role="alert" className="warehouse-error">{recoveryError}</p>}
      {recoverySuccess && <p role="status">{recoverySuccess}</p>}
    </div>}
    {validationNotice && <p role="status" className="warehouse-notice">{validationNotice}</p>}
    {items.length === 0 && <p className="warehouse-muted">Aucun brouillon pour le moment.</p>}
    {items.map((draft, index) => <DraftCard draft={draft} dispatchActive={dispatch.data?.active === true} key={draft.id} open={openDraft === draft.id} onDirtyChange={onDirtyChange} onToggle={() => { setValidationNotice(''); setOpenDraft((current) => current === draft.id ? null : draft.id) }} onMove={(direction) => { setValidationNotice(''); moveDraft(index + direction) }} onValidated={() => moveAfterValidation(index)} position={index + 1} total={items.length} />)}
  </section>
}
