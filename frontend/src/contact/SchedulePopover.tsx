import type { ReactNode } from 'react'

import { Button } from '../ui/Button'
import { TextField } from '../ui/fields'
import { AlertIcon, CalendarIcon } from '../ui/icons'
import { InfoTip } from '../ui/InfoTip'
import { Popover } from '../ui/Popover'
import type { DispatchReason } from '../api/contact'
import { inactiveSentence } from './dispatchCopy'
import { DispatchWarning } from './DispatchWarning'
import { localDay } from './mailModel'

interface SchedulePopoverProps {
  anchor: HTMLElement
  fieldId: (field: string) => string
  date: string
  time: string
  onChange: (next: { date: string; time: string }) => void
  // « Heure locale (Europe/Paris, UTC+1) ».
  zone: string
  busy: boolean
  // The typed moment is refused (past, too far, empty).
  error: string | undefined
  // The server really sends scheduled mails; otherwise the reason it will not is said, and scheduling stays possible.
  automatic: boolean
  dispatchReason: DispatchReason | null
  // The step order warning (R1 before Contact…).
  warning: string | null
  // « Programmer l'envoi… » (a validated message); null for a draft, whose primary action already takes the moment.
  confirm: { label: string; onClick: () => void } | null
  // The validation will schedule too.
  optional: boolean
  onClose: () => void
  children?: ReactNode
}

// The send moment, behind « Programmer… »: date + time, and only the warnings that concern this moment.
export function SchedulePopover({
  anchor,
  fieldId,
  date,
  time,
  onChange,
  zone,
  busy,
  error,
  automatic,
  dispatchReason,
  warning,
  confirm,
  optional,
  onClose,
}: SchedulePopoverProps) {
  return (
    <Popover anchor={anchor} label="Programmer l’envoi" onClose={onClose} above alignRight className="mail-popover">
      <fieldset className="mail-schedule" disabled={busy} aria-label={optional ? 'Programmer l’envoi (facultatif)' : 'Programmer l’envoi'}>
        <legend className="mail-schedule__legend">
          <CalendarIcon size={16} />
          {optional ? 'Programmer l’envoi (facultatif)' : 'Programmer l’envoi'}
          <InfoTip label="Aide : programmation">
            Heure locale ({zone}). Aucune heure n’est proposée par défaut.
            {optional ? ' Renseignées, la date et l’heure permettent de valider et programmer en une seule fois.' : ''}
          </InfoTip>
        </legend>
        <div className="mail-schedule__when">
          <TextField
            id={fieldId('date')}
            label="Date d’envoi"
            type="date"
            min={localDay(new Date())}
            value={date}
            onChange={(event) => {
              onChange({ date: event.target.value, time })
            }}
          />
          <TextField
            id={fieldId('time')}
            label="Heure"
            type="time"
            value={time}
            onChange={(event) => {
              onChange({ date, time: event.target.value })
            }}
          />
        </div>
        {error && (
          <p className="field__error" role="alert">
            <AlertIcon size={16} />
            {error}
          </p>
        )}
        {!automatic && (
          <DispatchWarning reason={dispatchReason}>{inactiveSentence(dispatchReason)} Vous pouvez programmer quand même.</DispatchWarning>
        )}
        {warning && (
          <p className="field__warning">
            <AlertIcon size={16} />
            {warning}
          </p>
        )}
        {confirm && (
          <div className="mail-popover__foot">
            <Button size="sm" variant="primary" icon={CalendarIcon} onClick={confirm.onClick}>
              {confirm.label}
            </Button>
          </div>
        )}
      </fieldset>
    </Popover>
  )
}
