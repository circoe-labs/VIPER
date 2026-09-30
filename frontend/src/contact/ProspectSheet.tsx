import { Link } from 'react-router'

import type { ChannelVerification } from '../api/prospection'
import type { Prospect } from '../api/prospects'
import { parseIsoWeek } from '../lib/isoWeek'
import { civilityLabel, formatPhone, personName } from '../prospection/labels'
import { prospectionHref } from '../prospection/criteria'
import { StateBadge, WeekBadge } from '../prospection/TrackingBadges'
import { EditorSection } from '../prospects/EditorSection'
import { Badge, StatusBadge, type StatusTone } from '../ui/Badge'
import { BanIcon, BuildingIcon, ExpandIcon } from '../ui/icons'
import '../prospects/prospects.css'

const VERIFICATION: Record<ChannelVerification, { tone: StatusTone; label: string }> = {
  verified: { tone: 'success', label: 'Vérifié' },
  unverified: { tone: 'warning', label: 'Non vérifié' },
  invalid: { tone: 'danger', label: 'Invalide' },
  unknown: { tone: 'neutral', label: 'Non confirmé' },
}

const PHONE_TYPES = { mobile: 'Mobile', landline: 'Fixe', other: 'Autre' } as const

function initials(prospect: Prospect): string {
  return [prospect.first_name, prospect.last_name].map((part) => part?.trim()[0] ?? '').join('').toUpperCase() || '?'
}

// The read-mostly prospect sheet of the workbench (decision 19): who, where, how to reach them, and the two Contact
// indicators. Nothing here edits the record — « Ouvrir dans Prospection » leads to the full editor to correct it.
export function ProspectSheet({ prospect }: { prospect: Prospect }) {
  const civility = civilityLabel(prospect.civility)
  const week = parseIsoWeek(prospect.tracking?.planned_contact_week)
  const blocked = prospect.contactability_status === 'do_not_contact'
  const title = [prospect.role?.label, prospect.exact_job_title].filter(Boolean)
  const emails = prospect.emails.filter((email) => email.is_active)
  const phones = prospect.phones.filter((phone) => phone.is_active)
  return (
    <>
      <section className="prospect-editor__section contact-sheet" aria-labelledby="contact-sheet-name" data-tone={blocked ? 'danger' : undefined}>
        <div className="contact-sheet__identity">
          <span className="contact-row__avatar" aria-hidden="true">
            {initials(prospect)}
          </span>
          <div className="contact-sheet__who">
            <h2 id="contact-sheet-name" className="contact-sheet__name">
              {civility && <span className="contact-row__muted">{civility} </span>}
              {personName(prospect) || 'Nom non renseigné'}
            </h2>
            <p className="contact-row__muted">{title.length > 0 ? title.join(' · ') : 'Rôle non renseigné'}</p>
          </div>
        </div>
        <p className="contact-row__company">
          <BuildingIcon size={16} />
          {prospect.company?.display_name ?? <span className="contact-row__muted">Sans entreprise</span>}
          {prospect.company?.city && <span className="contact-row__muted">· {prospect.company.city}</span>}
        </p>
        <div className="contact-row__badges">
          <StateBadge status={prospect.tracking?.status ?? null} />
          {week && <WeekBadge week={week} today={prospect.today} />}
          {blocked && (
            <StatusBadge tone="danger" icon={BanIcon}>
              Ne pas contacter
            </StatusBadge>
          )}
          {!week && (prospect.tracking?.status ?? 'neutral') === 'neutral' && (
            <span className="contact-row__muted">Aucun état · aucune semaine</span>
          )}
        </div>
        {blocked && prospect.do_not_contact_reason && (
          <p className="prospect-editor__note prospect-editor__note--danger">Motif : {prospect.do_not_contact_reason}</p>
        )}
        <Link className="btn btn--ghost btn--sm contact-sheet__open" to={prospectionHref({ prospect: prospect.id })}>
          <ExpandIcon size={16} />
          Ouvrir dans Prospection
        </Link>
      </section>

      <EditorSection title="Coordonnées">
        {emails.length === 0 && phones.length === 0 && (
          <p className="contact-row__muted">Aucune coordonnée active : complétez la fiche dans Prospection.</p>
        )}
        {emails.length > 0 && (
          <ul className="contact-sheet__channels" aria-label="E-mails">
            {emails.map((email) => (
              <li key={email.id}>
                <span className="contact-sheet__channel" title={email.address}>
                  {email.address}
                </span>
                <span className="contact-sheet__tags">
                  {email.is_primary && <Badge>Principal</Badge>}
                  <StatusBadge tone={VERIFICATION[email.verification_status].tone}>
                    {VERIFICATION[email.verification_status].label}
                  </StatusBadge>
                </span>
              </li>
            ))}
          </ul>
        )}
        {phones.length > 0 && (
          <ul className="contact-sheet__channels" aria-label="Téléphones">
            {phones.map((phone) => (
              <li key={phone.id}>
                <span className="contact-sheet__channel">
                  {formatPhone(phone.number)} <span className="contact-row__muted">· {PHONE_TYPES[phone.type]}</span>
                </span>
                <span className="contact-sheet__tags">{phone.is_primary && <Badge>Principal</Badge>}</span>
              </li>
            ))}
          </ul>
        )}
      </EditorSection>
    </>
  )
}
