import { useState } from 'react'

import { type MessageVersion, useSavedMails } from '../api/contact'
import { StatusBadge } from '../ui/Badge'
import { Button } from '../ui/Button'
import { Modal } from '../ui/Dialog'
import { BookmarkIcon } from '../ui/icons'
import { formatDateTime, formatShortDateTime } from './labels'
import { configSummary, ratingTone } from './mailRatings'

function RatingChip({ rating }: { rating: number }) {
  return (
    <span className="saved-mail__rating" title={`Note ${String(rating)} sur 10`}>
      <StatusBadge tone={ratingTone(rating)}>{rating}/10</StatusBadge>
    </span>
  )
}

// The prospect's saved mails (« Sauvegarder » in the mail editor) in the « Suivi de contact » block: date, step, the
// coloured note, the subject on one line (the comment on hover); a click opens the whole mail, its config and note.
export function SavedMails({ prospectId }: { prospectId: string }) {
  const query = useSavedMails(prospectId)
  const [opened, setOpened] = useState<MessageVersion | null>(null)
  const saved = query.data?.saved ?? []
  // Nothing to say before the first saved mail: the editor's « Sauvegarder » is the entry point.
  if (query.isPending || (saved.length === 0 && !query.isError)) return null
  return (
    <div className="saved-mails">
      <h4 className="saved-mails__title">
        <BookmarkIcon size={14} /> Mails sauvegardés <span className="saved-mails__count">{saved.length}</span>
      </h4>
      {query.isError && (
        <p className="contact-panel__error" role="alert">
          Mails sauvegardés indisponibles.
          <Button size="sm" onClick={() => void query.refetch()}>
            Réessayer
          </Button>
        </p>
      )}
      <ul className="saved-mails__list">
        {saved.map((mail) => (
          <li key={mail.id}>
            <button
              type="button"
              className="saved-mail"
              title={mail.comment ?? 'Ouvrir le mail sauvegardé'}
              onClick={() => {
                setOpened(mail)
              }}
            >
              <time className="saved-mail__date" dateTime={mail.saved_at ?? undefined}>
                {formatShortDateTime(mail.saved_at ?? mail.created_at)}
              </time>
              <span className="saved-mail__step">{mail.step_label}</span>
              {mail.rating !== null && <RatingChip rating={mail.rating} />}
              <span className="saved-mail__subject">{mail.subject.trim() || 'Sans objet'}</span>
            </button>
          </li>
        ))}
      </ul>
      {opened && (
        <SavedMailDialog
          mail={opened}
          onClose={() => {
            setOpened(null)
          }}
        />
      )}
    </div>
  )
}

// The full saved mail: text, the config it was generated with and the human note.
export function SavedMailDialog({ mail, onClose }: { mail: MessageVersion; onClose: () => void }) {
  const config = configSummary(mail.config)
  return (
    <Modal open size="lg" title={`Mail sauvegardé · ${mail.step_label}`} onClose={onClose} footer={<Button onClick={onClose}>Fermer</Button>}>
      <div className="saved-dialog">
        <div className="saved-dialog__note">
          {mail.rating !== null && <RatingChip rating={mail.rating} />}
          <span className="saved-dialog__by">
            {mail.saved_by ?? 'Quelqu’un'} · {formatDateTime(mail.saved_at ?? mail.created_at)}
          </span>
        </div>
        {mail.comment && <p className="saved-dialog__comment">« {mail.comment} »</p>}
        {config && <p className="saved-dialog__config">{config}</p>}
        {mail.config.instruction && <p className="saved-dialog__config">Consigne : {mail.config.instruction}</p>}
        <dl className="saved-dialog__headers">
          {mail.from_email && (
            <div>
              <dt>De</dt>
              <dd>{mail.from_email}</dd>
            </div>
          )}
          {mail.to.length > 0 && (
            <div>
              <dt>À</dt>
              <dd>{mail.to.join(', ')}</dd>
            </div>
          )}
          <div>
            <dt>Objet</dt>
            <dd>{mail.subject || '—'}</dd>
          </div>
        </dl>
        <pre className="saved-dialog__body">{mail.body_text}</pre>
      </div>
    </Modal>
  )
}
