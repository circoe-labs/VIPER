import type { ReactNode } from 'react'

import type { Prospect } from '../api/prospects'
import { useProspectSequences } from '../api/sequences'
import { CohortBadge, DueBadge, EmailErrorBadge, StateBadge } from '../prospection/ContactBadges'
import { formatDay, stepLabel, TRACKING_LABELS } from '../prospection/labels'
import { InfoTip } from '../ui/InfoTip'
import type { TrackingDraft } from './prospectForm'
import { isDue, pauseText } from './sequenceModel'
import { SendBadge, SendLines } from '../contact/SendStatus'
import './tracking-tab.css'

interface TrackingOverviewProps {
  prospect: Prospect
  // The form's live tracking values: the band follows what is typed, like the form it summarises.
  tracking: TrackingDraft
}

function Cell({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="tracking-overview__cell">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  )
}

const hint = (text: string) => <span className="tracking-overview__hint">{text}</span>

// The scan-first band of the Suivi tab (Slice 6): current commercial state, next action and key dates, read in one
// glance before any form. Read-only: every value comes from data the tab already holds (the editor's draft, the
// prospect, the sequence read model); it never changes a state and adds no rule.
export function TrackingOverview({ prospect, tracking }: TrackingOverviewProps) {
  const query = useProspectSequences(prospect.id)
  const place = query.data?.place
  const status = tracking.status || null
  const saved = prospect.tracking
  const since = saved?.status === status ? saved.status_since : null
  const answered = tracking.response_received_on !== '' || status === 'response_received' || status === 'appointment_obtained'
  const paused = place ? pauseText(place, status ?? 'neutral') : null
  const appointment = tracking.appointment_on
    ? `${formatDay(tracking.appointment_on)}${tracking.appointment_time ? ` à ${tracking.appointment_time.slice(0, 5)}` : ''}`
    : null
  const cohort = prospect.contact.cohort

  return (
    <section className="tracking-overview" aria-label="Synthèse du suivi">
      <dl className="tracking-overview__group">
        <Cell label="État commercial">
          {status && status !== 'neutral' ? <StateBadge status={status} /> : <strong>{TRACKING_LABELS[status ?? 'neutral']}</strong>}
          {since && hint(`depuis le ${formatDay(since)}`)}
        </Cell>
      </dl>
      <dl className="tracking-overview__group">
        <Cell label="Prochaine action">
          {query.isPending && hint('Chargement…')}
          {query.isError && hint('Indisponible')}
          {place?.send && (
            <span className="tracking-overview__line">
              <SendBadge send={place.send} />
              <SendLines send={place.send} />
            </span>
          )}
          {place && !(place.send?.step === place.next_step && (place.send.state === 'scheduled' || place.send.state === 'unconfirmed')) &&
            (place.next_due_on && place.next_step ? (
              <>
                <strong>{stepLabel(place.next_step)}</strong>
                <span className="tracking-overview__line">
                  {place.send ? 'échéance théorique : ' : ''}le {formatDay(place.next_due_on)}
                  {isDue(place, prospect.today) && <DueBadge />}
                </span>
              </>
            ) : (
              <span className="tracking-overview__line">
                <strong>Aucun envoi prévu</strong>
                {paused && <InfoTip label="Pourquoi aucun envoi">{paused}</InfoTip>}
              </span>
            ))}
          {place?.email_error && <EmailErrorBadge />}
        </Cell>
      </dl>
      <dl className="tracking-overview__group tracking-overview__group--dates">
        <Cell label="Semaine">
          {cohort ? (
            <>
              <CohortBadge code={cohort.code} />
              {cohort.starts_on && hint(`1er envoi le ${formatDay(cohort.starts_on)}`)}
            </>
          ) : (
            hint('Aucune')
          )}
        </Cell>
        <Cell label="Réponse">
          {tracking.response_received_on ? <strong>{formatDay(tracking.response_received_on)}</strong> : hint(answered ? 'Date à renseigner' : 'Aucune')}
        </Cell>
        <Cell label="Rendez-vous">
          {appointment ? <strong>{appointment}</strong> : hint(answered ? 'Date à renseigner' : 'Aucun')}
        </Cell>
        <Cell label="Référent">{saved?.referent?.label ? <strong>{saved.referent.label}</strong> : hint('—')}</Cell>
      </dl>
    </section>
  )
}
