import type { KeyboardEvent } from 'react'
import { Link, useNavigate } from 'react-router'

import type { ProspectRow } from '../api/prospection'
import { StatusBadge } from '../ui/Badge'
import { AlertIcon, BanIcon, BuildingIcon, CheckCircleIcon, CopyIcon, MailIcon, UsersIcon } from '../ui/icons'
import { useRowMenu } from '../ui/RowMenu'
import { SendBadge, SendLines } from '../contact/SendStatus'
import { LifecycleBadge } from '../lifecycle/LifecycleBadge'
import { useLifecycleMenu } from '../lifecycle/useLifecycleMenu'
import { CohortBadge, DueBadge, EmailErrorBadge, LevelBadge, StateBadge } from './ContactBadges'
import {
  civilityLabel,
  formatDay,
  formatPhone,
  personName,
  stepLabel,
} from './labels'

interface ProspectListProps {
  rows: ProspectRow[]
  // URL (search part) that opens a prospect: the current list URL plus `prospect=<id>`.
  openHref: (id: string) => string
}

function initials(row: ProspectRow): string {
  return [row.first_name, row.last_name].map((part) => part?.trim()[0] ?? '').join('').toUpperCase() || '?'
}

// ↑/↓ move between people, Home/End jump to the first/last one; Enter opens (native link).
function moveFocus(event: KeyboardEvent<HTMLUListElement>) {
  const links = [...event.currentTarget.querySelectorAll<HTMLAnchorElement>('.prospect-row__open')]
  const index = links.findIndex((link) => link === document.activeElement)
  if (index < 0) return
  const target = {
    ArrowDown: Math.min(index + 1, links.length - 1),
    ArrowUp: Math.max(index - 1, 0),
    Home: 0,
    End: links.length - 1,
  }[event.key]
  if (target === undefined) return
  event.preventDefault()
  links[target]?.focus()
}

// One line says where the file stands: the date when verified, the reason when it is still to do. The panel decides
// the group (`row.review`, from the backend); the reason only explains it.
// What an incomplete file lacks of the minimum to e-mail the person (verified e-mail, name, company, role).
function reasonIncomplete(row: ProspectRow): string {
  const missing: string[] = []
  if (row.email_state !== 'verified') {
    missing.push({ missing: 'e-mail absent', invalid: 'e-mail invalide', unverified: 'e-mail non vérifié', verified: '' }[row.email_state])
  }
  if (!row.first_name || !row.last_name) missing.push('nom')
  if (!row.company_id) missing.push('société')
  if (!row.role_label) missing.push('rôle')
  return missing.length > 0 ? `Manque : ${missing.join(', ')}` : 'Fiche incomplète'
}

function reasonToVerify(row: ProspectRow): string {
  switch (row.verification_state) {
    case 'never_verified':
      return 'Validation de l’emploi non enregistrée'
    case 'stale':
      return `Vérifié le ${formatDay(row.employment_verified_at ?? '')} · ancien`
    case 'channels_reset':
      return 'Coordonnées à revérifier'
    case 'verified':
      return { missing: 'E-mail principal absent', invalid: 'E-mail invalide', unverified: 'E-mail non vérifié', verified: '' }[
        row.email_state
      ]
  }
}

function ReviewLine({ row }: { row: ProspectRow }) {
  // An incomplete file reads as incomplete first, even when its employment was validated once.
  if (row.review === 'incomplete' && row.employment_verified_at) {
    return <div>
      <span className="review-line review-line--to-verify"><AlertIcon size={16} />{reasonIncomplete(row)}</span>
      <span className="prospect-row__muted">Emploi validé le {formatDay(row.employment_verified_at)}</span>
    </div>
  }
  if (row.review !== 'ignored' && row.employment_verified_at) {
    return <div>
      <span className="review-line review-line--verified"><CheckCircleIcon size={16} /><span>Emploi validé <span className="prospect-row__muted">le {formatDay(row.employment_verified_at)}</span></span></span>
    </div>
  }
  switch (row.review) {
    case 'verified':
      return (
        <span className="review-line review-line--verified">
          <CheckCircleIcon size={16} />
          <span>
            Emploi validé
            {row.employment_verified_at && (
              <span className="prospect-row__muted"> le {formatDay(row.employment_verified_at)}</span>
            )}
          </span>
        </span>
      )
    case 'ignored':
      return (
        <span className="review-line review-line--ignored">
          <BanIcon size={16} />
          Ignoré
        </span>
      )
    case 'usable':
      return (
        <span className="review-line review-line--to-verify">
          <CheckCircleIcon size={16} />
          Exploitable
          {row.verification_state !== 'verified' && <span className="prospect-row__muted"> · {reasonToVerify(row)}</span>}
        </span>
      )
    case 'incomplete':
      return (
        <span className="review-line review-line--to-verify">
          <AlertIcon size={16} />
          {reasonIncomplete(row)}
        </span>
      )
  }
}

const EMAIL_DOTS = { verified: 'Adresse vérifiée', unverified: 'Adresse non vérifiée', invalid: 'Adresse invalide' } as const

// The address in plain text; a dot carries its state (and a screen-reader word), instead of a badge per row.
function EmailLine({ row }: { row: ProspectRow }) {
  if (!row.primary_email || row.email_state === 'missing')
    return <span className="prospect-row__muted">Pas d’e-mail principal</span>
  const state = row.email_state
  return (
    <span className="prospect-row__channel">
      <span className={`prospect-row__dot prospect-row__dot--${state}`} aria-hidden="true" />
      <span className="prospect-row__email" title={row.primary_email}>
        {row.primary_email}
      </span>
      <span className="visually-hidden">{EMAIL_DOTS[state]}</span>
    </span>
  )
}

// The step to send next and when (derived from the cohort and the real sends): « R1 à envoyer depuis le 14 sept. »
// once due, « … le 21 sept. » before.
function nextSend(row: ProspectRow): string | null {
  if (!row.next_due_at || !row.next_step) return null
  const state = row.send?.step === row.next_step ? row.send.state : null
  // Scheduled: the effective date is said instead (`SendLines`). Missed: the due date is only theoretical.
  if (state === 'scheduled' || state === 'unconfirmed') return null
  if (state) return `Échéance théorique : ${formatDay(row.next_due_at)}`
  return `${stepLabel(row.next_step)} à envoyer ${row.due ? 'depuis le' : 'le'} ${formatDay(row.next_due_at)}`
}

// The contact follow-up: the cohort (or « Sans campagne »), the level reached by the real sends, the commercial state
// (none while « En séquence ») and what takes the person out of the automatic actions, then the next send, the dates
// and the referent (sequences rework D1-D9).
function Tracking({ row }: { row: ProspectRow }) {
  const inCampaign = row.cohort_code !== null && row.cohort_code !== 'S0'
  const next = nextSend(row)
  return (
    <>
      <span className="prospect-row__stage">
        <CohortBadge code={row.cohort_code} />
        {/* Someone out of prospecting has nothing « à envoyer ». */}
        {inCampaign && !(row.block && row.sent_count === 0) && <LevelBadge level={row.level} />}
        <StateBadge status={row.tracking_status} />
        {row.email_error && <EmailErrorBadge />}
        {row.send && <SendBadge send={row.send} />}
        {row.due && <DueBadge />}
      </span>
      {row.send && <SendLines send={row.send} />}
      {next && <span>{next}</span>}
      {row.response_received_at && <span>Réponse le {formatDay(row.response_received_at)}</span>}
      {row.appointment_at && <span>Rendez-vous le {formatDay(row.appointment_at)}</span>}
      {row.referent_name && <span className="prospect-row__muted">Référent : {row.referent_name}</span>}
    </>
  )
}

// The people list: one readable card per person — identity with its states, company and contacts, contact follow-up.
// The name is the row's link — the whole card is clickable — and opens the prospect (prospectEditor.tsx).
export function ProspectList({ rows, openHref }: ProspectListProps) {
  const navigate = useNavigate()
  const lifecycle = useLifecycleMenu()
  const rowMenu = useRowMenu<ProspectRow>(
    (row) => `Actions de ${personName(row)}`,
    (row) => [
      { id: 'open', label: 'Ouvrir la fiche', icon: UsersIcon, onSelect: () => { void navigate(openHref(row.id)) } },
      { id: 'emails', label: 'Modifier les e-mails', icon: MailIcon, onSelect: () => { void navigate(`${openHref(row.id)}&section=emails`) } },
      ...lifecycle.items({ type: 'prospect', id: row.id, name: personName(row) }),
      {
        id: 'copy-email',
        label: 'Copier l’e-mail',
        icon: CopyIcon,
        disabled: !row.primary_email,
        onSelect: () => { if (row.primary_email) void navigator.clipboard.writeText(row.primary_email) },
      },
    ],
  )
  return (
    <>
      <ul className="prospect-list" aria-label="Prospects" onKeyDown={moveFocus}>
        {rows.map((row) => {
          const civility = civilityLabel(row.civility)
          const blocked = row.contactability_status === 'do_not_contact'
          const title = [row.role_label, row.exact_job_title].filter(Boolean)
          return (
            <li key={row.id} className={`prospect-row prospect-row--${row.review}${blocked ? ' prospect-row--blocked' : ''}`} onContextMenu={rowMenu.onContextMenu(row)}>
              <div className="prospect-row__identity">
                <span className="prospect-row__avatar" aria-hidden="true">
                  {initials(row)}
                </span>
                <div className="prospect-row__who">
                  <span className="prospect-row__name-line">
                    {civility && <span className="prospect-row__civility">{civility}</span>}
                    <Link className="prospect-row__open" to={openHref(row.id)}>
                      {personName(row)}
                    </Link>
                    {blocked && (
                      <StatusBadge tone="danger" icon={BanIcon} strong>
                        Ne pas contacter
                      </StatusBadge>
                    )}
                    <LifecycleBadge block={row.block} hideOpposition />
                  </span>
                  <span className="prospect-row__title">
                    {title.length > 0 ? title.join(' · ') : <span className="prospect-row__muted">Rôle non renseigné</span>}
                    {row.activity_status === 'inactive' && row.block !== 'prospect_departed' && <span className="prospect-row__left"> · Plus en poste</span>}
                  </span>
                </div>
              </div>
              <div className="prospect-row__contact">
                <span className="prospect-row__company">
                  <BuildingIcon size={16} />
                  {row.company_name ?? <span className="prospect-row__muted">Sans entreprise</span>}
                </span>
                <EmailLine row={row} />
                {row.primary_phone && <span className="prospect-row__muted">{formatPhone(row.primary_phone)}</span>}
              </div>
              <div className="prospect-row__review">
                <ReviewLine row={row} />
              </div>
              <div className="prospect-row__tracking">
                <Tracking row={row} />
              </div>
              <div className="row-actions row-actions--corner">{rowMenu.button(row)}</div>
            </li>
          )
        })}
      </ul>
      {rowMenu.menu}
      {lifecycle.dialog}
    </>
  )
}
