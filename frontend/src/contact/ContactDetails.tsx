import { Link } from 'react-router'

import { useProspect } from '../api/prospects'
import { useProspectSequences } from '../api/sequences'
import { formatDay } from '../prospection/labels'
import { Button } from '../ui/Button'
import { SpinnerIcon } from '../ui/icons'
import { FROM_LIST } from './criteria'
import { MessageBadge } from './MessageBadge'
import { formatDateTime, stepLabel } from './labels'

export function ContactDetails({ id, name, openHref }: { id: string; name: string; openHref: string }) {
  const prospect = useProspect(id)
  const history = useProspectSequences(id)
  const person = prospect.data
  return (
    <section id={`contact-details-${id}`} className="contacts-details" aria-label={`Fiche de ${name}`}>
      {prospect.isPending && <p role="status"><SpinnerIcon size={16} /> Chargement de la fiche…</p>}
      {prospect.isError && <p role="alert">Fiche indisponible. <Button size="sm" onClick={() => void prospect.refetch()}>Réessayer</Button></p>}
      {person && <div className="contacts-details__information">
        <h3>Informations du prospect</h3>
        <dl>
          <div><dt>Nom</dt><dd>{[person.first_name, person.last_name].filter(Boolean).join(' ')}</dd></div>
          {person.company && <div><dt>Entreprise</dt><dd>{person.company.display_name}</dd></div>}
          {(person.exact_job_title ?? person.role?.label) && <div><dt>Fonction</dt><dd>{person.exact_job_title ?? person.role?.label}</dd></div>}
          {person.emails.filter((email) => email.is_active).map((email) => <div key={email.id}><dt>E-mail</dt><dd><a href={`mailto:${email.address}`}>{email.address}</a></dd></div>)}
          {person.phones.filter((phone) => phone.is_active).map((phone) => <div key={phone.id}><dt>Téléphone</dt><dd><a href={`tel:${phone.number}`}>{phone.number}</a></dd></div>)}
        </dl>
        <Link to={`/prospection?prospect=${id}`} className="btn btn--secondary btn--sm">Modifier la fiche</Link>
      </div>}
      <div className="contacts-details__history">
        <h3>Historique des échanges</h3>
        {person?.tracking?.response_received_on && <p>Réponse reçue le {formatDay(person.tracking.response_received_on)}</p>}
        {person?.tracking?.appointment_on && <p>Rendez-vous enregistré pour le {formatDay(person.tracking.appointment_on)}</p>}
        {history.isPending && <p role="status">Chargement de l’historique…</p>}
        {history.isError && <p role="alert">Historique indisponible. <Button size="sm" onClick={() => void history.refetch()}>Réessayer</Button></p>}
        {history.data?.sequences.map((sequence) => {
          const ranks = [...new Set([
            ...(sequence.is_current ? Array.from({ length: history.data.place.max_follow_ups + 1 }, (_, rank) => rank) : []),
            ...sequence.messages.map((message) => message.rank),
          ])].sort((a, b) => a - b)
          return <div key={sequence.id} className="contacts-details__sequence">
            <h4>{sequence.is_current ? 'Séquence actuelle' : 'Séquence précédente'}</h4>
            <ol>
              {ranks.map((rank) => {
                const message = sequence.messages.find((entry) => entry.rank === rank)
                return <li key={rank}>
                  <strong>{rank === 0 ? 'Contact initial' : `Relance R${String(rank)}`}</strong>
                  {message ? <MessageBadge status={message.status} /> : <span className="contacts-details__todo">À réaliser</span>}
                  {message?.status === 'sent' && (message.sent_at ? <span>Envoyé le <time dateTime={message.sent_at}>{formatDateTime(message.sent_at)}</time></span> : <span>Date d’envoi non renseignée</span>)}
                </li>
              })}
            </ol>
          </div>
        })}
        {history.data?.sequences.length === 0 && <p>Aucun échange enregistré.</p>}
        {history.data?.place.next_step && <p className="contacts-details__next">Prochaine étape : {stepLabel(history.data.place.next_step)}</p>}
        <Link to={openHref} state={FROM_LIST} className="btn btn--secondary btn--sm">Ouvrir le suivi et les messages</Link>
      </div>
    </section>
  )
}
