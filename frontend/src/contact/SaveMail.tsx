import { useState } from 'react'

import type { SavedMailNote } from '../api/contact'
import { Button } from '../ui/Button'
import { TextAreaField } from '../ui/fields'
import { BookmarkIcon } from '../ui/icons'
import { Popover } from '../ui/Popover'
import { RATING_ENDS, RATING_VALUES, ratingTone } from './mailRatings'

interface SaveMailProps {
  anchor: HTMLElement
  stepLabel: string
  idPrefix: string
  saving: boolean
  error: string | null
  // The humanizer score of the text when it is known (it is kept with the config).
  humanizerScore?: number
  onSave: (note: SavedMailNote) => void
  onClose: () => void
}

// « Sauvegarder »: keep THIS mail, with the config it was generated with, as a reference. A human note 0-10 (0 = never
// do that again, 10 = keep this style) and an optional comment; nothing is sent or validated by it.
export function SaveMailPopover({ anchor, stepLabel, idPrefix, saving, error, humanizerScore, onSave, onClose }: SaveMailProps) {
  const [rating, setRating] = useState<number | null>(null)
  const [comment, setComment] = useState('')
  return (
    <Popover
      anchor={anchor}
      label={`Sauvegarder le message ${stepLabel}`}
      alignRight
      above
      className="mail-popover mail-popover--wide mail-save"
      onClose={onClose}
    >
      <form
        className="mail-save__form"
        onSubmit={(event) => {
          event.preventDefault()
          if (rating === null) return
          onSave({ rating, comment: comment.trim() || null, ...(humanizerScore === undefined ? {} : { humanizer_score: humanizerScore }) })
        }}
      >
        <div className="mail-save__head">
          <BookmarkIcon size={16} />
          <strong>Sauvegarder ce mail</strong>
        </div>
        <div className="mail-save__scale" role="radiogroup" aria-label="Note de 0 à 10">
          {RATING_VALUES.map((value) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={rating === value}
              className={`mail-save__rate mail-save__rate--${ratingTone(value)}`}
              title={value === 0 ? RATING_ENDS.low : value === 10 ? RATING_ENDS.high : `Note ${String(value)} sur 10`}
              onClick={() => {
                setRating(value)
              }}
            >
              {value}
            </button>
          ))}
        </div>
        <div className="mail-save__ends" aria-hidden="true">
          <span title={RATING_ENDS.low}>0 · à ne jamais refaire</span>
          <span title={RATING_ENDS.high}>10 · à garder</span>
        </div>
        <TextAreaField
          id={`${idPrefix}-comment`}
          label="Commentaire (facultatif)"
          rows={3}
          maxLength={2000}
          value={comment}
          onChange={(event) => {
            setComment(event.target.value)
          }}
        />
        {error && (
          <p className="field__error" role="alert">
            {error}
          </p>
        )}
        <div className="mail-popover__foot">
          <Button
            type="submit"
            size="sm"
            variant="primary"
            icon={BookmarkIcon}
            loading={saving}
            disabled={rating === null}
            title={rating === null ? 'Choisissez une note de 0 à 10' : undefined}
          >
            Sauvegarder
          </Button>
        </div>
      </form>
    </Popover>
  )
}
