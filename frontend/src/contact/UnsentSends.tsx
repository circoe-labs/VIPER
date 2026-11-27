import { useState } from 'react'
import { Link } from 'react-router'

import { type RecoveryResult, type RecoveryTarget, type UnsentItem, useRecoveryMutations, useUnsent } from '../api/unsent'
import { StatusBadge } from '../ui/Badge'
import { Button } from '../ui/Button'
import { Checkbox, TextField } from '../ui/fields'
import { AlertIcon, CalendarIcon, RefreshIcon, SpinnerIcon } from '../ui/icons'
import { InfoTip } from '../ui/InfoTip'
import { FROM_LIST } from './criteria'
import { formatDateTime } from './labels'
import { localDay, localZoneLabel, scheduleToIso } from './mailModel'
import { messageRefusal } from './messages'
import { SendBadge, SendLines } from './SendStatus'

const keyOf = (item: UnsentItem) => `${item.prospect_id}:${String(item.send.rank)}`
const nameOf = (item: UnsentItem) => [item.first_name, item.last_name].filter(Boolean).join(' ') || 'Sans nom'
const plural = (count: number, one: string, many: string) => `${String(count)} ${count > 1 ? many : one}`

const REFUSALS: Record<string, string> = {
  sent_check_required: 'envoi à vérifier',
  revision_conflict: 'message modifié entre-temps',
  invalid_transition: 'à revalider ou déjà traité',
  dispatch_in_progress: 'envoi en cours',
  prospect_sequence_closed: 'séquence close',
  prospect_do_not_contact: 'opposition « Ne pas contacter »',
}

function resultText(done: string, result: RecoveryResult, items: UnsentItem[]): string {
  const parts = [done]
  if (result.refused.length > 0) {
    const named = result.refused.map((refused) => {
      const item = items.find((entry) => entry.prospect_id === refused.prospect_id && entry.send.rank === refused.rank)
      return `${item ? nameOf(item) : 'Prospect'} (${REFUSALS[refused.code] ?? refused.code})`
    })
    parts.push(`${plural(result.refused.length, 'refusé', 'refusés')} : ${named.join(', ')}`)
  }
  if (result.remote_draft_failures > 0) {
    parts.push(
      `${plural(result.remote_draft_failures, 'brouillon Infomaniak non créé', 'brouillons Infomaniak non créés')} (nouvel essai à l’heure d’envoi)`,
    )
  }
  return `${parts.join(' ; ')}.`
}

interface GroupProps {
  title: string
  help: string
  items: UnsentItem[]
  openHref: (id: string) => string
  // `reschedule` asks for a new moment; `recreate` keeps it and makes a new Infomaniak draft.
  action: 'reschedule' | 'recreate'
  mutations: ReturnType<typeof useRecoveryMutations>
}

// Only a validated mail that is not waiting for an outcome can be recovered from here.
function selectable(item: UnsentItem, action: GroupProps['action']): boolean {
  return action === 'recreate' ? item.kind === 'draft_missing' : item.kind === 'missed' && item.status === 'validated'
}

function Group({ title, help, items, openHref, action, mutations }: GroupProps) {
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set())
  const [checked, setChecked] = useState(false)
  const [date, setDate] = useState('')
  const [time, setTime] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const [result, setResult] = useState<string | null>(null)

  const eligible = items.filter((item) => selectable(item, action))
  const chosen = eligible.filter((item) => picked.has(keyOf(item)))
  const toCheck = chosen.filter((item) => item.send.needs_sent_check)
  const safe = eligible.filter((item) => !item.send.needs_sent_check)
  const risky = eligible.filter((item) => item.send.needs_sent_check)
  const busy = mutations.reschedule.isPending || mutations.recreate.isPending

  // A new selection is a new question: the confirmation never carries over to messages it did not cover.
  function choose(next: ReadonlySet<string>) {
    setPicked(next)
    setChecked(false)
    setProblem(null)
  }

  function toggle(item: UnsentItem) {
    const next = new Set(picked)
    if (!next.delete(keyOf(item))) next.add(keyOf(item))
    choose(next)
  }

  async function submit() {
    setProblem(null)
    setResult(null)
    const targets: RecoveryTarget[] = chosen.map((item) => ({
      prospect_id: item.prospect_id,
      rank: item.send.rank,
      expected_revision: item.revision,
      sent_check_confirmed: item.send.needs_sent_check && checked,
    }))
    try {
      if (action === 'recreate') {
        const answer = await mutations.recreate.mutateAsync(targets)
        setResult(resultText(plural(answer.done, 'brouillon recréé', 'brouillons recréés'), answer, items))
      } else {
        const moment = scheduleToIso(date, time, new Date())
        if (!moment.ok) {
          setProblem(moment.error)
          return
        }
        const answer = await mutations.reschedule.mutateAsync({ at: moment.iso, items: targets })
        const done = `${plural(answer.done, 'message reprogrammé', 'messages reprogrammés')} pour le ${formatDateTime(moment.iso)}`
        setResult(resultText(done, answer, items))
      }
      choose(new Set())
    } catch (error) {
      setProblem(
        error instanceof Error && error.name === 'TimeoutError'
          ? 'Le serveur n’a pas répondu en 3 minutes : la liste est relue, vérifiez ce qui a été traité avant de recommencer.'
          : messageRefusal(error).message,
      )
    }
  }

  return (
    <div className="unsent__group">
      <h3>
        {title} ({items.length})<InfoTip label={`Aide : ${title}`}>{help}</InfoTip>
      </h3>
      {eligible.length > 0 && (
        <div className="unsent__actions">
          {safe.length > 0 && (
            <Button size="sm" disabled={busy} onClick={() => { choose(new Set(safe.map(keyOf))) }}>
              Sélectionner les {safe.length} sans doute possible
            </Button>
          )}
          {risky.length > 0 && (
            <Button size="sm" disabled={busy} onClick={() => { choose(new Set([...picked, ...risky.map(keyOf)])) }}>
              Ajouter les {risky.length} à vérifier
            </Button>
          )}
          {chosen.length > 0 && (
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => { choose(new Set()) }}>
              Tout désélectionner
            </Button>
          )}
        </div>
      )}
      <ul className="unsent__list" aria-label={title}>
        {items.map((item) => (
          <li key={keyOf(item)} className="unsent__row">
            <input
              type="checkbox"
              className="unsent__pick"
              aria-label={`Sélectionner ${nameOf(item)}, ${item.send.step_label}`}
              checked={picked.has(keyOf(item)) && selectable(item, action)}
              disabled={busy || !selectable(item, action)}
              onChange={() => { toggle(item) }}
            />
            <span className="unsent__who">
              <Link to={openHref(item.prospect_id)} state={FROM_LIST}>{nameOf(item)}</Link>
              <span>{[item.company_name, item.cohort_code].filter(Boolean).join(' · ') || 'Sans entreprise'}</span>
            </span>
            <SendLines send={item.send} />
            <span className="unsent__flags">
              <SendBadge send={item.send} />
              {item.send.needs_sent_check && <StatusBadge tone="warning" icon={AlertIcon}>Vérifier les Envoyés</StatusBadge>}
              {item.kind === 'unconfirmed' && <StatusBadge tone="warning">À trancher sur la fiche</StatusBadge>}
              {item.status === 'draft' && <StatusBadge tone="neutral">À revalider</StatusBadge>}
            </span>
          </li>
        ))}
      </ul>
      {chosen.length > 0 && (
        <div className="unsent__actions">
          {toCheck.length > 0 && (
            <div className="unsent__confirm">
              <Checkbox
                label={`J’ai vérifié le dossier Envoyés d’Infomaniak : ${plural(toCheck.length, 'ce message à vérifier n’est pas parti', 'ces messages à vérifier ne sont pas partis')}`}
                checked={checked}
                disabled={busy}
                onChange={(event) => { setChecked(event.target.checked) }}
              />
            </div>
          )}
          {action === 'reschedule' && (
            <>
              <TextField label="Nouvelle date d’envoi" type="date" min={localDay(new Date())} value={date} disabled={busy} onChange={(event) => { setDate(event.target.value) }} />
              <TextField label={`Heure (${localZoneLabel(new Date())})`} type="time" value={time} disabled={busy} onChange={(event) => { setTime(event.target.value) }} />
            </>
          )}
          <Button
            variant="primary"
            icon={action === 'recreate' ? RefreshIcon : CalendarIcon}
            loading={busy}
            disabled={toCheck.length > 0 && !checked}
            onClick={() => void submit()}
          >
            {action === 'recreate' ? `Recréer ${plural(chosen.length, 'brouillon', 'brouillons')}` : `Reprogrammer ${plural(chosen.length, 'message', 'messages')}`}
          </Button>
        </div>
      )}
      {busy && (
        <p role="status" className="unsent__result">
          <SpinnerIcon size={16} className="btn__spinner" /> Traitement en cours, brouillons Infomaniak compris (3 minutes au plus)…
        </p>
      )}
      {problem && <p className="field__error" role="alert"><AlertIcon size={16} />{problem}</p>}
      {result && <p role="status" className="unsent__result">{result}</p>}
    </div>
  )
}

// Contact › the scheduled mails that did not leave (or may have, or lost their Infomaniak draft). Nothing here is ever
// sent again by itself: a person reviews, confirms the sent items when in doubt, and chooses the new moment.
export function UnsentSends({ openHref }: { openHref: (id: string) => string }) {
  const unsent = useUnsent()
  const mutations = useRecoveryMutations()
  if (unsent.isError) {
    return (
      <div className="contact__state contact__state--error" role="alert">
        <AlertIcon size={18} /> Envois non partis indisponibles ({unsent.error.message}).
        <Button size="sm" onClick={() => void unsent.refetch()}>Réessayer</Button>
      </div>
    )
  }
  const data = unsent.data
  if (!data || (data.items.length === 0 && data.unverified_drafts === 0)) return null
  const notSent = data.items.filter((item) => item.kind !== 'draft_missing')
  const lost = data.items.filter((item) => item.kind === 'draft_missing')
  const check = mutations.check
  return (
    <section className="unsent" aria-label="Envois à reprendre">
      <div className="unsent__head">
        <h2>
          <AlertIcon size={18} /> Envois à reprendre
          <InfoTip label="Aide : envois à reprendre">
            VIPER ne renvoie jamais un mail de lui-même. Déjà parti à la main ? Ouvrez la fiche et utilisez « Marquer comme
            envoyé ».
          </InfoTip>
        </h2>
        <Button size="sm" icon={RefreshIcon} loading={check.isPending} onClick={() => { check.mutate() }}>
          Vérifier les brouillons
        </Button>
      </div>
      {check.isError && <p className="field__error" role="alert"><AlertIcon size={16} />{messageRefusal(check.error).message}</p>}
      {check.data && (
        <p role="status" className="unsent__result">
          Vérification faite : {plural(check.data.present, 'brouillon présent', 'brouillons présents')}, {plural(check.data.missing, 'introuvable', 'introuvables')}, {plural(check.data.unverified, 'non vérifiable', 'non vérifiables')}.
        </p>
      )}
      {data.unverified_drafts > 0 && (
        <p className="unsent__result">
          <StatusBadge tone="warning" icon={AlertIcon}>
            {plural(data.unverified_drafts, 'brouillon programmé non vérifiable', 'brouillons programmés non vérifiables')}
          </StatusBadge>
          <InfoTip label="Aide : brouillons non vérifiables">
            La Toolbox ne liste que 100 brouillons : au-delà, VIPER ne peut pas confirmer qu’un brouillon existe encore.
            Videz les brouillons inutiles d’Infomaniak puis vérifiez à nouveau.
          </InfoTip>
        </p>
      )}
      {notSent.length > 0 && (
        <Group
          title="Mails non partis"
          help="Programmés puis revenus sans envoi. Choisissez-les, puis une nouvelle date. Ceux marqués « Vérifier les Envoyés » ont peut-être été envoyés : contrôlez la boîte avant de confirmer."
          items={notSent}
          openHref={openHref}
          action="reschedule"
          mutations={mutations}
        />
      )}
      {lost.length > 0 && (
        <Group
          title="Brouillons introuvables (toujours programmés)"
          help="Le brouillon n’est plus dans la boîte connectée (autre compte, supprimé, ou envoyé à la main). Après contrôle des Envoyés, VIPER en recrée un et garde la date."
          items={lost}
          openHref={openHref}
          action="recreate"
          mutations={mutations}
        />
      )}
    </section>
  )
}
