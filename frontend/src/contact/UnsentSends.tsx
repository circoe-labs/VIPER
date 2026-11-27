import { useState } from 'react'
import { Link } from 'react-router'

import { type RecoveryResult, type RecoveryTarget, type UnsentItem, useRecoveryMutations, useUnsent } from '../api/unsent'
import { StatusBadge } from '../ui/Badge'
import { Button } from '../ui/Button'
import { Checkbox, TextField } from '../ui/fields'
import { AlertIcon, CalendarIcon, CheckCircleIcon, RefreshIcon, SpinnerIcon } from '../ui/icons'
import { InfoTip } from '../ui/InfoTip'
import { ConfirmDialog } from './ConfirmDialog'
import { FROM_LIST } from './criteria'
import { formatDateTime, formatShortDateTime } from './labels'
import { localDay, localZoneLabel, scheduleToIso } from './mailModel'
import { messageRefusal } from './messages'
import { SendBadge, SendLines } from './SendStatus'

// By message: an old week's doubtful mail and the current one of the same step are two rows.
const keyOf = (item: UnsentItem) => item.message_id
const nameOf = (item: UnsentItem) => [item.first_name, item.last_name].filter(Boolean).join(' ') || 'Sans nom'
// R2: the last step a sheet marks as sent.
const MAX_RANK = 2
const plural = (count: number, one: string, many: string) => `${String(count)} ${count > 1 ? many : one}`

const REFUSALS: Record<string, string> = {
  sent_check_required: 'envoi à vérifier',
  earlier_send_unconfirmed: 'envoi précédent non tranché',
  dispatch_release_too_early: 'trop tôt : l’envoi est peut-être en cours',
  revision_conflict: 'message modifié entre-temps',
  invalid_transition: 'à revalider ou déjà traité',
  dispatch_in_progress: 'envoi en cours',
  prospect_sequence_closed: 'séquence close',
  rank_beyond_max: 'trois e-mails au plus',
  prospect_do_not_contact: 'opposition « Ne pas contacter »',
  prospect_departed: 'plus en poste',
  prospect_archived: 'fiche archivée',
  company_archived: 'entreprise archivée',
  prospect_excluded: 'exclu temporairement',
  company_excluded: 'entreprise exclue',
  email_identity_doubt: 'identité e-mail à vérifier',
}

// A mail that left although VIPER does not know it, where the sheet cannot say so: beyond R2 (the sequence stops
// there), or of a former contact week.
const recordable = (item: UnsentItem) =>
  (item.send.rank > MAX_RANK || !item.current) && (item.kind === 'doubt' || item.kind === 'unconfirmed')

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

// `reschedule`: mails that did not leave, given a new moment. `doubt`: mails that may have left, rescheduled or only
// cleared once the person looked in the sent items. `recreate`: still scheduled, a new Infomaniak draft, same moment.
type GroupAction = 'reschedule' | 'doubt' | 'recreate'

interface GroupProps {
  title: string
  help: string
  items: UnsentItem[]
  openHref: (id: string) => string
  action: GroupAction
  mutations: ReturnType<typeof useRecoveryMutations>
  // What an action did, said by the panel: the group may be gone once its last mail is recovered.
  onResult: (text: string | null) => void
}

const canReschedule = (item: UnsentItem) => item.current && item.status === 'validated'

// A send waiting for an outcome is settled on the person's sheet, never from here, except one of a former contact week
// (no sheet shows it): « pas parti » is declared here.
function selectable(item: UnsentItem, action: GroupAction): boolean {
  if (action === 'recreate') return item.kind === 'draft_missing'
  if (action === 'doubt') return item.kind !== 'unconfirmed' || !item.current
  return canReschedule(item)
}

// What the confirmation covers, named one by one.
function covered(item: UnsentItem): string {
  const when = item.send.scheduled_at ? `, prévu le ${formatShortDateTime(item.send.scheduled_at)}` : ''
  return `${nameOf(item)} · ${item.send.step_label}${when}`
}

function Group({ title, help, items, openHref, action, mutations, onResult }: GroupProps) {
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set())
  const [checked, setChecked] = useState(false)
  const [date, setDate] = useState('')
  const [time, setTime] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  // The mail being declared sent, asked once more before it is recorded.
  const [declaring, setDeclaring] = useState<UnsentItem | null>(null)

  const eligible = items.filter((item) => selectable(item, action))
  const chosen = eligible.filter((item) => picked.has(keyOf(item)))
  const toCheck = chosen.filter((item) => item.send.needs_sent_check)
  const schedulable = action === 'recreate' ? chosen : chosen.filter(canReschedule)
  const busy = mutations.reschedule.isPending || mutations.recreate.isPending || mutations.confirm.isPending || mutations.recordSent.isPending
  const unconfirmed = toCheck.length > 0 && !checked

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

  async function run(work: () => Promise<string>) {
    setProblem(null)
    onResult(null)
    try {
      onResult(await work())
      choose(new Set())
    } catch (error) {
      setProblem(
        error instanceof Error && error.name === 'TimeoutError'
          ? 'Le serveur n’a pas répondu en 3 minutes : la liste est relue, vérifiez ce qui a été traité avant de recommencer.'
          : messageRefusal(error).message,
      )
    }
  }

  const targets = (list: UnsentItem[]): RecoveryTarget[] =>
    list.map((item) => ({
      prospect_id: item.prospect_id,
      rank: item.send.rank,
      expected_revision: item.revision,
      sent_check_confirmed: item.send.needs_sent_check && checked,
    }))

  function submit() {
    if (action === 'recreate') {
      void run(async () => {
        const answer = await mutations.recreate.mutateAsync(targets(chosen))
        return resultText(plural(answer.done, 'brouillon recréé', 'brouillons recréés'), answer, items)
      })
      return
    }
    const moment = scheduleToIso(date, time, new Date())
    if (!moment.ok) {
      setProblem(moment.error)
      return
    }
    void run(async () => {
      const answer = await mutations.reschedule.mutateAsync({ at: moment.iso, items: targets(schedulable) })
      const done = `${plural(answer.done, 'message reprogrammé', 'messages reprogrammés')} pour le ${formatDateTime(moment.iso)}`
      return resultText(done, answer, items)
    })
  }

  function recordSent(item: UnsentItem) {
    void run(async () => {
      await mutations.recordSent.mutateAsync({ message_id: item.message_id, expected_revision: item.revision })
      return `${covered(item)} : enregistré comme envoyé.`
    }).finally(() => { setDeclaring(null) })
  }

  function confirmNotSent() {
    void run(async () => {
      const answer = await mutations.confirm.mutateAsync(
        chosen.map((item) => ({ message_id: item.message_id, expected_revision: item.revision })),
      )
      const done = plural(answer.done, 'mail confirmé non parti', 'mails confirmés non partis')
      return resultText(done, { ...answer, remote_draft_failures: 0 }, items)
    })
  }

  return (
    <div className="unsent__group">
      <h3>
        {title} ({items.length})<InfoTip label={`Aide : ${title}`}>{help}</InfoTip>
      </h3>
      {eligible.length > 0 && (
        <div className="unsent__actions">
          {chosen.length < eligible.length && (
            <Button size="sm" disabled={busy} onClick={() => { choose(new Set(eligible.map(keyOf))) }}>
              Tout sélectionner ({eligible.length})
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
              {item.kind === 'unconfirmed' && <StatusBadge tone="warning">{item.current ? 'À trancher sur la fiche' : 'Bloque les nouveaux envois'}</StatusBadge>}
              {!item.current && <StatusBadge tone="neutral">Ancienne semaine de contact</StatusBadge>}
              {item.status === 'draft' && <StatusBadge tone="neutral">À revalider</StatusBadge>}
              {item.status === 'cancelled' && <StatusBadge tone="neutral">Annulé</StatusBadge>}
              {recordable(item) && (
                <Button size="sm" icon={CheckCircleIcon} disabled={busy} aria-label={`Marquer comme envoyé : ${covered(item)}`} onClick={() => { setDeclaring(item) }}>
                  Marquer comme envoyé
                </Button>
              )}
            </span>
          </li>
        ))}
      </ul>
      {chosen.length > 0 && (
        <div className="unsent__actions">
          {toCheck.length > 0 && (
            <div className="unsent__confirm">
              <Checkbox
                label={
                  toCheck.length === 1
                    ? 'J’ai vérifié le dossier Envoyés d’Infomaniak : le mail ci-dessous n’est pas parti'
                    : `J’ai vérifié le dossier Envoyés d’Infomaniak : les ${String(toCheck.length)} mails ci-dessous ne sont pas partis`
                }
                checked={checked}
                disabled={busy}
                onChange={(event) => { setChecked(event.target.checked) }}
              />
              <ul className="unsent__covered" aria-label="Mails couverts par la confirmation">
                {toCheck.map((item) => <li key={keyOf(item)}>{covered(item)}</li>)}
              </ul>
            </div>
          )}
          {action !== 'recreate' && schedulable.length > 0 && (
            <>
              <TextField label="Nouvelle date d’envoi" type="date" min={localDay(new Date())} value={date} disabled={busy} onChange={(event) => { setDate(event.target.value) }} />
              <TextField label={`Heure (${localZoneLabel(new Date())})`} type="time" value={time} disabled={busy} onChange={(event) => { setTime(event.target.value) }} />
            </>
          )}
          {schedulable.length > 0 && (
            <Button
              variant="primary"
              icon={action === 'recreate' ? RefreshIcon : CalendarIcon}
              loading={mutations.reschedule.isPending || mutations.recreate.isPending}
              disabled={busy || unconfirmed}
              onClick={submit}
            >
              {action === 'recreate'
                ? `Recréer ${plural(schedulable.length, 'brouillon', 'brouillons')}`
                : `Reprogrammer ${plural(schedulable.length, 'message', 'messages')}`}
            </Button>
          )}
          {action === 'doubt' && (
            <Button loading={mutations.confirm.isPending} disabled={busy || unconfirmed} onClick={confirmNotSent}>
              Confirmer sans reprogrammer ({chosen.length})
            </Button>
          )}
        </div>
      )}
      {busy && (
        <p role="status" className="unsent__result">
          <SpinnerIcon size={16} className="btn__spinner" /> Traitement en cours, brouillons Infomaniak compris (3 minutes au plus)…
        </p>
      )}
      {problem && <p className="field__error" role="alert"><AlertIcon size={16} />{problem}</p>}
      <ConfirmDialog
        confirmation={declaring && {
          title: 'Marquer ce mail comme envoyé ?',
          lines: [
            covered(declaring),
            'Confirmez seulement après l’avoir trouvé dans les éléments envoyés d’Infomaniak. L’envoi est inscrit dans l’historique ; VIPER n’envoie rien.',
          ],
          confirmLabel: 'Marquer envoyé',
        }}
        busy={mutations.recordSent.isPending}
        onConfirm={() => { if (declaring) recordSent(declaring) }}
        onClose={() => { setDeclaring(null) }}
      />
    </div>
  )
}

// Contact › the scheduled mails that did not leave (or may have, or lost their Infomaniak draft). Nothing here is ever
// sent again by itself: a person reviews, confirms the sent items when in doubt, and chooses the new moment.
export function UnsentSends({ openHref }: { openHref: (id: string) => string }) {
  const unsent = useUnsent()
  const mutations = useRecoveryMutations()
  const [result, setResult] = useState<string | null>(null)
  if (unsent.isError) {
    return (
      <div className="contact__state contact__state--error" role="alert">
        <AlertIcon size={18} /> Envois non partis indisponibles ({unsent.error.message}).
        <Button size="sm" onClick={() => void unsent.refetch()}>Réessayer</Button>
      </div>
    )
  }
  const data = unsent.data
  if (!data || (data.items.length === 0 && data.unverified_drafts === 0 && result === null)) return null
  const doubtful = data.items.filter(
    (item) => item.kind !== 'draft_missing' && (item.kind !== 'missed' || item.send.needs_sent_check),
  )
  const notSent = data.items.filter((item) => item.kind === 'missed' && !item.send.needs_sent_check)
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
      {result && <p role="status" className="unsent__result">{result}</p>}
      {doubtful.length > 0 && (
        <Group
          title="Peut-être partis : à vérifier"
          help="Ces mails sont peut-être déjà partis (envoi non confirmé, brouillon disparu). Contrôlez le dossier Envoyés d’Infomaniak. Pas parti : reprogrammez-le ou confirmez-le. Parti : ouvrez la fiche et « Marquer comme envoyé »."
          items={doubtful}
          openHref={openHref}
          action="doubt"
          mutations={mutations}
          onResult={setResult}
        />
      )}
      {notSent.length > 0 && (
        <Group
          title="Mails non partis"
          help="Programmés puis revenus sans envoi. Choisissez-les, puis une nouvelle date."
          items={notSent}
          openHref={openHref}
          action="reschedule"
          mutations={mutations}
          onResult={setResult}
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
          onResult={setResult}
        />
      )}
    </section>
  )
}
