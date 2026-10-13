import { useState } from 'react'

import { useScheduleCohorts } from '../api/contact'
import { Button } from '../ui/Button'
import { TextField } from '../ui/fields'
import { AlertIcon, CalendarIcon } from '../ui/icons'
import { Modal } from '../ui/Dialog'
import { formatDateTime } from './labels'
import { localDay, localZoneLabel, scheduleToIso } from './mailModel'
import { rememberedMoment, rememberMoment } from './lastMoment'
import { Notice } from './Notice'

// Every step up to R4 (« max relances » is 4 by default); the server refuses a rank beyond the setting.
const STEPS = ['contact', 'r1', 'r2', 'r3', 'r4'] as const
type Step = (typeof STEPS)[number]
const STEP_LABEL: Record<Step, string> = { contact: 'Contact', r1: 'R1', r2: 'R2', r3: 'R3', r4: 'R4' }

// « Programmer une série »: a date and a time typed once, applied to the validated mail of the chosen step for every
// prospect of the chosen cohorts — instead of typing them prospect by prospect. Drafts are never validated for the
// person: they stay as they are and the result says how many.
export function ScheduleCohorts({ cohort }: { cohort: string }) {
  const [open, setOpen] = useState(false)
  const [step, setStep] = useState<Step>('contact')
  const [date, setDate] = useState(() => rememberedMoment('contact').date)
  const [time, setTime] = useState(() => rememberedMoment('contact').time)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const schedule = useScheduleCohorts()

  function close() {
    if (schedule.isPending) return
    setOpen(false)
    setError(null)
  }

  async function submit() {
    setError(null)
    const parsed = scheduleToIso(date, time, new Date())
    if (!parsed.ok) {
      setError(parsed.error)
      return
    }
    try {
      const result = await schedule.mutateAsync({
        cohorts: [cohort],
        step,
        scheduled_at: parsed.iso,
      })
      rememberMoment(step, { date, time })
      const parts = [
        `${String(result.scheduled)} mail${result.scheduled > 1 ? 's' : ''} ${STEP_LABEL[step]} programmé${result.scheduled > 1 ? 's' : ''} pour le ${formatDateTime(parsed.iso)}`,
      ]
      if (result.validated > 0)
        parts.push(`dont ${String(result.validated)} validé${result.validated > 1 ? 's' : ''} au passage`)
      if (result.missing > 0)
        parts.push(`${String(result.missing)} prospect${result.missing > 1 ? 's' : ''} sans mail à cette étape`)
      if (result.refused > 0)
        parts.push(`${String(result.refused)} refusé${result.refused > 1 ? 's' : ''} (brouillon incomplet ?)`)
      if (result.remote_draft_failures > 0)
        parts.push(
          `${String(result.remote_draft_failures)} brouillon${result.remote_draft_failures > 1 ? 's' : ''} Infomaniak à recréer`,
        )
      setDone(`${parts.join(' ; ')}.`)
      setOpen(false)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'La programmation a échoué.')
    }
  }

  return (
    <>
      <Button
        icon={CalendarIcon}
        onClick={() => {
          setDone(null)
          setOpen(true)
        }}
      >
        Programmer les mails
      </Button>
      <Notice
        text={done}
        tone={
          done?.includes('refusé') || done?.includes('sans mail') || done?.includes('Infomaniak')
            ? 'warning'
            : 'success'
        }
      />
      <Modal
        open={open}
        size="md"
        title={`Programmer la série ${cohort}`}
        description={`Une seule date et une seule heure pour tous les mails validés de l’étape choisie, pour tous les prospects de la série ${cohort}.`}
        onClose={close}
        footer={
          <>
            <Button disabled={schedule.isPending} onClick={close}>
              Annuler
            </Button>
            <Button variant="primary" loading={schedule.isPending} onClick={() => void submit()}>
              Programmer
            </Button>
          </>
        }
      >
        <div className="schedule-cohorts">
          <fieldset className="schedule-cohorts__group">
            <legend>Étape</legend>
            {STEPS.map((code) => (
              <label key={code} className="schedule-cohorts__choice">
                <input
                  type="radio"
                  name={`schedule-step-${cohort}`}
                  checked={step === code}
                  onChange={() => {
                    setStep(code)
                  }}
                />
                {STEP_LABEL[code]}
              </label>
            ))}
          </fieldset>
          <div className="schedule-cohorts__when">
            <TextField
              label="Date d’envoi"
              type="date"
              min={localDay(new Date())}
              value={date}
              onChange={(event) => {
                setDate(event.target.value)
              }}
            />
            <TextField
              label="Heure"
              type="time"
              value={time}
              onChange={(event) => {
                setTime(event.target.value)
              }}
            />
          </div>
          <p className="schedule-cohorts__hint">
            Heure locale ({localZoneLabel(new Date())}). Les brouillons complets sont validés puis programmés ; les
            brouillons incomplets (objet ou corps manquant) sont laissés tels quels.
          </p>
          {error && (
            <p className="field__error" role="alert">
              <AlertIcon size={16} />
              {error}
            </p>
          )}
        </div>
      </Modal>
    </>
  )
}
