import { useEffect, useRef } from 'react'
import { Link } from 'react-router'

import type { ChannelVerification } from '../api/prospection'
import type { Prospect } from '../api/prospects'
import { CohortBadge, EmailErrorBadge, LevelBadge, StateBadge } from '../prospection/ContactBadges'
import { prospectionHref } from '../prospection/criteria'
import { civilityLabel, formatPhone, personName, TO_VERIFY } from '../prospection/labels'
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

// The read-mostly prospect sheet of the workbench (decision 19): who, where, how to reach them, and the Contact
// indicators (cohort, level, state, « Erreur sur le mail »). A missing function, e-mail or phone (without another
// channel) reads « À vérifier » (D12). Nothing here edits the record — « Ouvrir dans Prospection » leads to the full editor to correct it.
// The sheet's heading takes the focus when the prospect opens (from the list, « Précédent » / « Suivant »): keyboard and
// screen-reader users start on the person, not on a button that no longer exists.
export function ProspectSheet({ prospect }: { prospect: Prospect }) {
  const headingRef = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    headingRef.current?.focus()
  }, [])
  const civility = civilityLabel(prospect.civility)
  const contact = prospect.contact
  const inCampaign = contact.cohort !== null && !contact.cohort.out_of_campaign
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
            <h2 ref={headingRef} id="contact-sheet-name" className="contact-sheet__name" tabIndex={-1}>
              {civility && <span className="contact-row__muted">{civility} </span>}
              {personName(prospect) || 'Nom non renseigné'}
            </h2>
            <p className="contact-row__muted">
              {[...title, prospect.exact_job_title ? null : `Fonction : ${TO_VERIFY}`].filter(Boolean).join(' · ')}
            </p>
          </div>
        </div>
        <p className="contact-row__company">
          <BuildingIcon size={16} />
          {prospect.company?.display_name ?? <span className="contact-row__muted">Sans entreprise</span>}
          {prospect.company?.city && <span className="contact-row__muted">· {prospect.company.city}</span>}
        </p>
        <div className="contact-row__badges">
          <CohortBadge code={contact.cohort?.code ?? null} startsOn={contact.cohort?.starts_on ?? null} />
          {inCampaign && <LevelBadge level={contact.level} />}
          <StateBadge status={prospect.tracking?.status ?? null} />
          {contact.email_error && <EmailErrorBadge />}
          {blocked && (
            <StatusBadge tone="danger" icon={BanIcon}>
              Ne pas contacter
            </StatusBadge>
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
        {emails.length === 0 && (
          <p>
            <StatusBadge tone="warning">E-mail : {TO_VERIFY}</StatusBadge>
          </p>
        )}
        {emails.length === 0 && phones.length === 0 && (
          <p>
            <StatusBadge tone="warning">Téléphone : {TO_VERIFY}</StatusBadge>
          </p>
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
