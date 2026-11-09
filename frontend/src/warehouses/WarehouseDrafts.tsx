import { useState } from 'react'
import { type WarehouseDraft, useWarehouseDispatchStatus, useWarehouseDraftActions, useWarehouseDrafts } from '../api/warehouses'
import { Button, IconButton } from '../ui/Button'
import { TextAreaField, TextField } from '../ui/fields'
import { ChevronDownIcon, ChevronLeftIcon, ChevronRightIcon } from '../ui/icons'

function localDateTime(value: string | null): string {
  if (!value) return ''
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return ''
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000)
  return local.toISOString().slice(0, 16)
}

function DraftCard({ draft, dispatchActive, open, onToggle, onMove, position, total }: {
  draft: WarehouseDraft; dispatchActive: boolean; open: boolean; onToggle: () => void
  onMove: (direction: -1 | 1) => void; position: number; total: number
}) {
  const [recipient, setRecipient] = useState(draft.recipient ?? '')
  const [subject, setSubject] = useState(draft.subject)
  const [body, setBody] = useState(draft.body)
  const [error, setError] = useState('')
  const [selectedWhen, setWhen] = useState<string | null>(null)
  const when = selectedWhen ?? (draft.send_state === 'planned' ? localDateTime(draft.scheduled_at) : '')
  const actions = useWarehouseDraftActions()
  const dirty = recipient !== (draft.recipient ?? '') || subject !== draft.subject || body !== draft.body
  const busy = actions.save.isPending || actions.validate.isPending || actions.schedule.isPending || actions.unschedule.isPending
  const locked = ['scheduled', 'sending', 'uncertain', 'sent'].includes(draft.send_state ?? '')
  const valid = Boolean(draft.validated_at) && !dirty
  async function save() {
    setError('')
    try { await actions.save.mutateAsync({ id: draft.id, revision: draft.revision, recipient, subject, body }) }
    catch { setError('Enregistrement impossible. Vérifiez les champs ou rechargez la page si le brouillon a changé.') }
  }
  async function validate() {
    setError('')
    try { await actions.validate.mutateAsync({ id: draft.id, revision: draft.revision }) }
    catch { setError('Validation impossible. Enregistrez une adresse valide et rechargez si le brouillon a changé.') }
  }
  async function schedule() {
    setError('')
    const at = new Date(when)
    if (!when || !Number.isFinite(at.getTime()) || at.getTime() <= Date.now()) { setError('Choisissez une date et une heure futures.'); return }
    try { await actions.schedule.mutateAsync({ id: draft.id, revision: draft.revision, scheduled_at: at.toISOString() }) }
    catch { setError('Programmation impossible. Vérifiez les champs et rechargez la page si le brouillon a changé.') }
  }
  async function unschedule() {
    setError('')
    try { await actions.unschedule.mutateAsync({ id: draft.id, revision: draft.revision }) }
    catch { setError('Impossible de retirer la programmation. Rechargez pour vérifier son état.') }
  }
  const mailto = `mailto:${encodeURIComponent(draft.recipient ?? '')}?subject=${encodeURIComponent(draft.subject)}&body=${encodeURIComponent(draft.body)}`
  return <details className="warehouse-draft" open={open}>
    <summary id={`warehouse-draft-${draft.id}`} onClick={(event) => { event.preventDefault(); onToggle() }}><ChevronDownIcon className="warehouse-draft__chevron" size={18} /><span><strong>{draft.contact_name}</strong><small>{draft.warehouse_name}{draft.contact_role ? ` · ${draft.contact_role}` : ''}</small><small>{draft.recipient || 'Destinataire à choisir'}</small></span><span className="warehouse-draft__badge">{draft.send_state === 'planned' ? 'Préprogrammé · à valider' : draft.send_state === 'scheduled' ? 'Programmé' : draft.send_state === 'sent' ? 'Envoyé' : draft.send_state === 'sending' || draft.send_state === 'uncertain' ? 'Envoi à vérifier' : draft.send_state === 'failed' ? 'Envoi non effectué' : valid ? 'Validé' : 'À vérifier'}</span></summary>
    <div className="warehouse-draft__content">
      <p><strong>Adresse source : </strong>{draft.source_email || 'Non renseignée'}</p>
      <p className="warehouse-draft__note">{draft.review_note}</p>
      <TextField label="Destinataire" type="email" value={recipient} disabled={locked} onChange={(e) => setRecipient(e.target.value)} hint="Choisissez et vérifiez une seule adresse." />
      <TextField label="Objet" value={subject} disabled={locked} onChange={(e) => setSubject(e.target.value)} />
      <TextAreaField label="Message" rows={12} value={body} disabled={locked} onChange={(e) => setBody(e.target.value)} />
      {!locked && <TextField label="Date et heure d’envoi" type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />}
      {draft.send_state === 'planned' && <p>Cette date est préparée. Relisez ce message puis cliquez sur « Valider et programmer » pour autoriser son envoi.</p>}
      {draft.send_state === 'scheduled' && draft.scheduled_at && <p>Programmé pour le {new Intl.DateTimeFormat('fr-FR', { dateStyle: 'long', timeStyle: 'short' }).format(new Date(draft.scheduled_at))}.</p>}
      {(draft.send_state === 'uncertain' || draft.send_state === 'sending') && <p role="alert">L’envoi n’est pas confirmé. Vérifiez la messagerie avant toute nouvelle tentative.</p>}
      {draft.send_state === 'failed' && <p role="alert">Envoi non effectué : vérifiez les paramètres d’envoi et l’adresse avant de reprogrammer.</p>}
      {!dispatchActive && draft.send_state !== 'sent' && <p role="status">L’envoi automatique est inactif : ce message ne partira pas tant qu’il ne sera pas activé et que la Toolbox ne sera pas connectée.</p>}
      {error && <p className="warehouse-error" role="alert">{error}</p>}
      <div className="warehouse-draft__actions">
        {!locked && <Button disabled={!dirty || busy} onClick={() => void save()}>Enregistrer</Button>}
        {!locked && <Button variant="primary" disabled={dirty || busy || !draft.recipient || !when} onClick={() => void schedule()}>Valider et programmer</Button>}
        {!locked && draft.send_state !== 'planned' && <Button disabled={dirty || busy || !draft.recipient || valid} onClick={() => void validate()}>Valider après relecture</Button>}
        {(draft.send_state === 'scheduled' || draft.send_state === 'planned') && <Button disabled={busy} onClick={() => void unschedule()}>Retirer la programmation</Button>}
        {valid && !locked && <a className="btn btn--secondary btn--md" href={mailto}>Ouvrir dans la messagerie</a>}
      </div>
      <p className="warehouse-muted">{valid ? `Validé par ${draft.validated_by ?? 'un utilisateur'}. ` : ''}La programmation utilise la connexion et les paramètres d’envoi de VIPER.</p>
      <nav className="warehouse-draft__navigation" aria-label="Navigation entre les brouillons">
        <span>{position} / {total}</span>
        <IconButton icon={ChevronLeftIcon} label="Brouillon précédent" variant="secondary" disabled={position === 1 || busy} onClick={() => onMove(-1)} />
        <IconButton icon={ChevronRightIcon} label="Brouillon suivant" variant="secondary" disabled={position === total || busy} onClick={() => onMove(1)} />
      </nav>
    </div>
  </details>
}

export function WarehouseDrafts() {
  const drafts = useWarehouseDrafts()
  const dispatch = useWarehouseDispatchStatus()
  const actions = useWarehouseDraftActions()
  const [batchWhen, setBatchWhen] = useState('')
  const [batchError, setBatchError] = useState('')
  const [batchSuccess, setBatchSuccess] = useState('')
  const [openDraft, setOpenDraft] = useState<string | null>(null)
  if (drafts.isPending) return <p role="status" className="warehouse-muted">Chargement des brouillons…</p>
  if (drafts.isError) return <p role="alert" className="warehouse-error">Impossible de charger les brouillons. <Button size="sm" onClick={() => void drafts.refetch()}>Réessayer</Button></p>
  const eligible = drafts.data.filter((draft) => draft.recipient && /^[^@\s,;]+@[^@\s,;]+\.[^@\s,;]+$/.test(draft.recipient) && draft.subject.trim() && draft.body.trim() && !['scheduled', 'sending', 'uncertain', 'sent'].includes(draft.send_state ?? ''))
  function moveDraft(index: number) {
    const target = drafts.data?.[index]
    if (!target) return
    setOpenDraft(target.id)
    requestAnimationFrame(() => {
      const summary = document.getElementById(`warehouse-draft-${target.id}`)
      summary?.scrollIntoView?.({ block: 'start', behavior: 'smooth' })
      summary?.focus({ preventScroll: true })
    })
  }
  async function scheduleAll() {
    setBatchError('')
    setBatchSuccess('')
    const at = new Date(batchWhen)
    if (!batchWhen || !Number.isFinite(at.getTime()) || at.getTime() <= Date.now()) { setBatchError('Choisissez une date et une heure futures.'); return }
    if (!window.confirm(`Préprogrammer ${String(eligible.length)} messages pour le ${new Intl.DateTimeFormat('fr-FR', { dateStyle: 'long', timeStyle: 'short' }).format(at)} ? Chaque message devra être relu et validé individuellement avant son envoi.`)) return
    try {
      const result = await actions.scheduleBatch.mutateAsync({ scheduled_at: at.toISOString(), drafts: eligible.map(({ id, revision }) => ({ id, revision })) })
      setBatchSuccess(`${String(result.planned)} messages préprogrammés. Chacun doit encore être relu et validé individuellement.`)
    } catch { setBatchError('Programmation groupée impossible. Rechargez la liste et vérifiez les destinataires et les messages.') }
  }
  return <section className="warehouse-drafts" aria-labelledby="warehouse-drafts-title">
    <div><h2 id="warehouse-drafts-title">Brouillons à vérifier ({drafts.data.length})</h2><p className="warehouse-muted">Ouvrez un message, vérifiez son destinataire et son contenu, enregistrez vos modifications puis validez-le.</p></div>
    <div className="warehouse-draft__content warehouse-draft">
      <h3>Préprogrammation groupée</h3>
      <p>{eligible.length} messages disponibles · {drafts.data.length - eligible.length} exclus (adresse manquante ou invalide, message incomplet, déjà programmé ou envoi à vérifier).</p>
      {!dispatch.data?.active && <p role="status">L’envoi automatique est inactif : les messages ne partiront pas tant qu’il ne sera pas activé et que la Toolbox ne sera pas connectée.</p>}
      <details><summary>Voir les destinataires et objets à programmer</summary><ul>{eligible.map((draft) => <li key={draft.id}>{draft.contact_name} — {draft.recipient} — {draft.subject}</li>)}</ul></details>
      <TextField label="Date et heure pour tous les messages" type="datetime-local" value={batchWhen} onChange={(e) => setBatchWhen(e.target.value)} />
      <div><Button variant="primary" disabled={!batchWhen || eligible.length === 0 || actions.scheduleBatch.isPending} onClick={() => void scheduleAll()}>Préprogrammer tous les messages</Button></div>
      <p className="warehouse-muted">La date sera préparée pour chaque brouillon. Aucun message ne partira sans validation individuelle après relecture.</p>
      {batchError && <p role="alert" className="warehouse-error">{batchError}</p>}
      {batchSuccess && <p role="status">{batchSuccess}</p>}
    </div>
    {drafts.data.length === 0 && <p className="warehouse-muted">Aucun brouillon pour le moment.</p>}
    {drafts.data.map((draft, index) => <DraftCard draft={draft} dispatchActive={dispatch.data?.active === true} key={draft.id} open={openDraft === draft.id} onToggle={() => setOpenDraft((current) => current === draft.id ? null : draft.id)} onMove={(direction) => moveDraft(index + direction)} position={index + 1} total={drafts.data.length} />)}
  </section>
}
