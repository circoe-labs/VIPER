import { useState } from 'react'

import type { ProspectRow } from '../api/prospection'
import { useProspect, useProspectMutations } from '../api/prospects'
import { type IsoWeek, parseIsoWeek, sameWeek, weekBadgeLabel } from '../lib/isoWeek'
import { prospectRefusal } from '../prospects/messages'
import { cadenceSuggestion, WeekPlanner } from '../prospects/WeekPlanner'
import { Button } from '../ui/Button'
import { AlertIcon, BanIcon, CalendarIcon, SpinnerIcon } from '../ui/icons'
import { Popover } from '../ui/Popover'
import { personName } from './labels'

// Quick planning of the next-action week from the Prospection list (handoff Task 06): the person's week only, saved
// at once through `PATCH /prospects/{id}/tracking` — the state is never sent, so a neutral person stays neutral. The
// popover reads the prospect first (its version, and the cadence proposal of its state).

interface QuickWeekPlannerProps {
  prospectId: string
  onDone: (notice: string | null) => void
}

function QuickWeekPlanner({ prospectId, onDone }: QuickWeekPlannerProps) {
  const loaded = useProspect(prospectId)
  const { tracking: save } = useProspectMutations()
  // undefined: nothing chosen yet (the stored week shows).
  const [choice, setChoice] = useState<IsoWeek | null | undefined>(undefined)
  const [error, setError] = useState<string | null>(null)

  if (loaded.isPending) {
    return (
      <p className="quick-plan__status" role="status">
        <SpinnerIcon size={16} className="btn__spinner" />
        Chargement de la fiche…
      </p>
    )
  }
  if (loaded.isError) {
    return (
      <div className="quick-plan">
        <p className="quick-plan__error" role="alert">
          <AlertIcon size={16} />
          La fiche n’a pas pu être lue ({loaded.error.message}).
        </p>
        <div className="quick-plan__actions">
          <Button size="sm" variant="ghost" onClick={() => { onDone(null) }}>
            Fermer
          </Button>
          <Button size="sm" onClick={() => void loaded.refetch()}>
            Réessayer
          </Button>
        </div>
      </div>
    )
  }

  const prospect = loaded.data
  const stored = parseIsoWeek(prospect.tracking?.planned_contact_week)
  const chosen = choice === undefined ? stored : choice
  const idPrefix = `quick-plan-${prospect.id}`

  async function submit() {
    setError(null)
    try {
      await save.mutateAsync({ id: prospect.id, version: prospect.version, patch: { next_action_week: chosen } })
      onDone(chosen ? `Semaine ${weekBadgeLabel(chosen)} enregistrée.` : 'Semaine retirée.')
    } catch (caught) {
      const refusal = prospectRefusal(caught)
      setError(refusal.conflict ? 'Ce prospect a été modifié entre-temps : la fiche est rechargée, vérifiez puis réessayez.' : refusal.message)
      if (refusal.conflict) {
        setChoice(undefined)
        void loaded.refetch()
      }
    }
  }

  return (
    <div className="quick-plan">
      {prospect.contactability_status === 'do_not_contact' && (
        <p className="quick-plan__error">
          <BanIcon size={16} />
          Opposition enregistrée : ne planifiez pas de contact.
        </p>
      )}
      <WeekPlanner
        idPrefix={idPrefix}
        value={chosen}
        today={prospect.today}
        suggestion={cadenceSuggestion(prospect.tracking, prospect.tracking?.status ?? '')}
        disabled={save.isPending}
        onChange={(week) => {
          setChoice(week)
          setError(null)
        }}
      />
      <p className="quick-plan__hint">Enregistrée tout de suite, sans changer l’état. Ce n’est pas une date d’envoi.</p>
      {error && (
        <p className="quick-plan__error" role="alert">
          <AlertIcon size={16} />
          {error}
        </p>
      )}
      <div className="quick-plan__actions">
        <Button size="sm" variant="ghost" onClick={() => { onDone(null) }}>
          Annuler
        </Button>
        <Button
          size="sm"
          variant="primary"
          loading={save.isPending}
          disabled={sameWeek(chosen, stored)}
          onClick={() => void submit()}
        >
          {chosen ? `Enregistrer ${weekBadgeLabel(chosen)}` : 'Retirer la semaine'}
        </Button>
      </div>
    </div>
  )
}

// The row's « Planifier » button and its popover. Not offered once « Ignoré » (no next action, decision 7).
export function PlanWeekButton({ row }: { row: ProspectRow }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const [notice, setNotice] = useState('')
  if (row.tracking_status === 'ignored') return null
  const name = personName(row) || 'ce prospect'
  const label = row.planned_contact_week ? 'Replanifier' : 'Planifier'
  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        icon={CalendarIcon}
        className="prospect-row__plan"
        aria-label={`${label} la semaine de ${name}`}
        aria-haspopup="dialog"
        aria-expanded={anchor !== null}
        onClick={(event) => {
          setNotice('')
          setAnchor(anchor ? null : event.currentTarget)
        }}
      >
        {label}
      </Button>
      <span className="visually-hidden" role="status">
        {notice}
      </span>
      {anchor && (
        <Popover
          anchor={anchor}
          label={`Prochaine semaine de ${name}`}
          alignRight
          onClose={() => {
            setAnchor(null)
          }}
        >
          <QuickWeekPlanner
            prospectId={row.id}
            onDone={(message) => {
              setAnchor(null)
              if (message) setNotice(message)
            }}
          />
        </Popover>
      )}
    </>
  )
}
