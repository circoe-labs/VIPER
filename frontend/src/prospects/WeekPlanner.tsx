import { useState } from 'react'

import type { TrackingStatus } from '../api/prospection'
import type { Tracking } from '../api/prospects'
import {
  addWeeks,
  type IsoWeek,
  isoWeekOf,
  mondayLabel,
  parseIsoWeek,
  relativeWeekLabel,
  sameWeek,
  weekBadgeLabel,
  weeksInYear,
} from '../lib/isoWeek'
import { TRACKING_LABELS } from '../prospection/labels'
import { WeekBadge } from '../prospection/TrackingBadges'
import { Button } from '../ui/Button'
import { SelectField } from '../ui/fields'
import { CalendarIcon, CheckIcon, CloseIcon } from '../ui/icons'
import './week-planner.css'

// The cadence proposal of the saved state (`tracking.suggested_next_contact_week`), with why it is proposed.
export interface CadenceSuggestion {
  week: IsoWeek
  // « après R1 »
  reason: string
}

// The server's cadence proposal for the saved state (`suggested_next_contact_week`: contacted/R1 +2 weeks, R2 +4 for
// the review), while the choice being made keeps that state — it was computed for it. Null otherwise.
export function cadenceSuggestion(tracking: Tracking | null, status: TrackingStatus | ''): CadenceSuggestion | null {
  const week = parseIsoWeek(tracking?.suggested_next_contact_week)
  if (!tracking || !week || tracking.status !== status) return null
  return { week, reason: `${tracking.status === 'r2' ? 'revue' : 'relance'} après ${TRACKING_LABELS[tracking.status]}` }
}

interface WeekPlannerProps {
  // Prefix of the controls' ids (the year and week selects).
  idPrefix: string
  // The chosen week, or null (no next action).
  value: IsoWeek | null
  // Business day, `YYYY-MM-DD`: « this week » and the relative wording.
  today: string
  onChange: (week: IsoWeek | null) => void
  suggestion?: CadenceSuggestion | null
  disabled?: boolean
}

// Years offered: the current one, the one before and the next two, plus the chosen one when outside.
function yearOptions(today: IsoWeek, chosen: number): number[] {
  return [...new Set([today.year - 1, today.year, today.year + 1, today.year + 2, chosen])].sort((a, b) => a - b)
}

// The next-action week picker (Contact decisions 5 and 14): a week, not a sending date nor a state. Controlled — the
// caller decides when it is saved (the editor's form, or the list's quick planning through PATCH). Year and week
// selects (53-week years handled), quick choices relative to this week, and the cadence proposal as a one-click choice
// — never applied by itself.
export function WeekPlanner({ idPrefix, value, today, onChange, suggestion = null, disabled = false }: WeekPlannerProps) {
  const current = isoWeekOf(today) ?? { year: 2000, week: 1 }
  // Year browsed while no week is chosen yet.
  const [browsedYear, setBrowsedYear] = useState(current.year)
  const year = value?.year ?? browsedYear
  const quick: { label: string; week: IsoWeek }[] = [
    { label: 'Cette semaine', week: current },
    { label: '+1 semaine', week: addWeeks(current, 1) },
    { label: '+2 semaines', week: addWeeks(current, 2) },
  ]
  return (
    <div className="week-planner" role="group" aria-labelledby={`${idPrefix}-title`}>
      <p id={`${idPrefix}-title`} className="week-planner__title">
        Prochaine action
      </p>
      <p className="week-planner__current" aria-live="polite">
        {value ? (
          <>
            <WeekBadge week={value} today={today} />
            <span>
              Semaine du {mondayLabel(value)} {String(value.year)} · {relativeWeekLabel(today, value)}
            </span>
          </>
        ) : (
          <span className="week-planner__none">Aucune semaine planifiée</span>
        )}
      </p>
      <div className="week-planner__selects">
        <SelectField
          id={`${idPrefix}-year`}
          label="Année"
          value={year}
          disabled={disabled}
          onChange={(event) => {
            const next = Number(event.target.value)
            if (value) onChange({ year: next, week: Math.min(value.week, weeksInYear(next)) })
            else setBrowsedYear(next)
          }}
        >
          {yearOptions(current, year).map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </SelectField>
        <SelectField
          id={`${idPrefix}-week`}
          label="Semaine"
          value={value?.week ?? ''}
          disabled={disabled}
          onChange={(event) => {
            onChange(event.target.value ? { year, week: Number(event.target.value) } : null)
          }}
        >
          <option value="">Aucune</option>
          {Array.from({ length: weeksInYear(year) }, (_, index) => {
            const week = { year, week: index + 1 }
            return (
              <option key={week.week} value={week.week}>
                {`${weekBadgeLabel(week)} · ${mondayLabel(week)}`}
              </option>
            )
          })}
        </SelectField>
      </div>
      <div className="week-planner__quick">
        {quick.map((choice) => {
          const chosen = sameWeek(value, choice.week)
          return (
            <Button
              key={choice.label}
              size="sm"
              variant="ghost"
              icon={chosen ? CheckIcon : undefined}
              disabled={disabled}
              aria-pressed={chosen}
              onClick={() => {
                onChange(choice.week)
              }}
            >
              {choice.label}
            </Button>
          )
        })}
        <Button
          size="sm"
          variant="ghost"
          icon={CloseIcon}
          disabled={disabled || value === null}
          onClick={() => {
            onChange(null)
          }}
        >
          Effacer
        </Button>
      </div>
      {suggestion && !disabled && (
        <div className="week-planner__suggestion">
          {sameWeek(value, suggestion.week) ? (
            <p className="week-planner__hint">
              <CalendarIcon size={16} />
              Semaine conforme à la cadence ({suggestion.reason}).
            </p>
          ) : (
            <Button
              size="sm"
              variant="secondary"
              icon={CalendarIcon}
              className="week-planner__apply"
              onClick={() => {
                onChange(suggestion.week)
              }}
            >
              {`Appliquer la cadence : ${weekBadgeLabel(suggestion.week)} (${suggestion.reason})`}
            </Button>
          )}
        </div>
      )}
    </div>
  )
}
