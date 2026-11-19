import { useState } from 'react'

import { Button } from '../ui/Button'
import { TextField } from '../ui/fields'
import { AlertIcon, MailIcon } from '../ui/icons'
import { Popover } from '../ui/Popover'
import { ADDRESS_MAX_LENGTH, type MailForm, parseRecipients, RECIPIENTS_MAX_LENGTH } from './mailModel'
import type { MailField } from './messages'

// « De l.jerier@… → À b.beaucamp@… »: the recipients on one line (and how many more in Cc / Cci).
export function recipientsRecap(form: MailForm): { from: string; to: string; more: number } {
  const first = (value: string) => {
    const all = parseRecipients(value)
    return all.length > 1 ? `${all[0] ?? ''} +${String(all.length - 1)}` : (all[0] ?? '')
  }
  return {
    from: form.from.trim(),
    to: first(form.to),
    more: parseRecipients(form.cc).length + parseRecipients(form.bcc).length,
  }
}

interface RecipientsProps {
  form: MailForm
  fieldId: (field: string) => string
  editable: boolean
  readOnly: boolean
  // The sender's field is not the one the Toolbox sends from.
  fromInfo: string | null
  errorOf: (field: MailField) => string | undefined
  open: boolean
  onOpenChange: (open: boolean) => void
  onEdit: (patch: Partial<MailForm>) => void
}

// The recipients, hidden behind one compact line: De / À / Cc / Cci open in a popover only when they must be edited.
export function RecipientsButton({ form, fieldId, editable, readOnly, fromInfo, errorOf, open, onOpenChange, onEdit }: RecipientsProps) {
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null)
  const recap = recipientsRecap(form)
  const failing = (['from', 'to', 'cc', 'bcc'] as const).some((field) => errorOf(field))
  const all = `De ${recap.from || '—'} → À ${recap.to || '—'}${recap.more > 0 ? ` (+${String(recap.more)} en copie)` : ''}`
  const field = (name: 'from' | 'to' | 'cc' | 'bcc', label: string, extra: { info?: string; type?: string; max: number }) => (
    <TextField
      id={fieldId(name)}
      label={label}
      type={extra.type}
      info={extra.info}
      maxLength={extra.max}
      value={form[name]}
      readOnly={readOnly}
      error={errorOf(name)}
      placeholder={name === 'from' && editable ? 'prospection@exemple.fr' : undefined}
      onChange={(event) => {
        onEdit({ [name]: event.target.value })
      }}
    />
  )
  return (
    <>
      <button
        ref={setAnchor}
        type="button"
        className={`mail-recipients${failing ? ' mail-recipients--error' : ''}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Destinataires : ${all}`}
        title="Destinataires (De, À, Cc, Cci) : cliquer pour modifier"
        onClick={() => {
          onOpenChange(!open)
        }}
      >
        {failing ? <AlertIcon size={16} /> : <MailIcon size={16} />}
        <span className="mail-recipients__line">
          <span className="mail-recipients__key">De</span> {recap.from || '—'}
          <span className="mail-recipients__arrow" aria-hidden="true">
            {' → '}
          </span>
          <span className="mail-recipients__key">À</span> {recap.to || '—'}
          {recap.more > 0 && <span className="mail-recipients__more"> +{recap.more}</span>}
        </span>
      </button>
      {open && anchor && (
        <Popover
          anchor={anchor}
          label="Destinataires"
          onClose={() => {
            onOpenChange(false)
          }}
          className="mail-popover mail-popover--wide"
        >
          <div className="mail-recipients-form">
            {field('from', 'De', { info: fromInfo ?? undefined, type: 'email', max: ADDRESS_MAX_LENGTH })}
            {field('to', 'À', { info: 'Plusieurs adresses dans un champ : séparez-les par une virgule.', max: RECIPIENTS_MAX_LENGTH })}
            <div className="mail-recipients-form__pair">
              {field('cc', 'Cc', { max: RECIPIENTS_MAX_LENGTH })}
              {field('bcc', 'Cci', { max: RECIPIENTS_MAX_LENGTH })}
            </div>
            <div className="mail-popover__foot">
              <Button
                size="sm"
                variant="primary"
                onClick={() => {
                  onOpenChange(false)
                }}
              >
                OK
              </Button>
            </div>
          </div>
        </Popover>
      )}
    </>
  )
}
