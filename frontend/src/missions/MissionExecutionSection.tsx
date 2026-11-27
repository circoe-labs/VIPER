import type { MissionEndKind, RecurrenceUnit } from '../api/missions'
import { SelectField, TextField } from '../ui/fields'
import { ClockIcon, PlayIcon, RepeatIcon } from '../ui/icons'
import { InfoTip } from '../ui/InfoTip'
import { UNIT_LABELS } from './labels'
import { TASK_COUNT_MAX, taskSplit } from './missionKinds'
import type { MissionFormApi } from './useMissionForm'

const UNITS: RecurrenceUnit[] = ['hours', 'days', 'weeks', 'months']

// « Exécution »: one-off vs recurring (the existing recurrence fields) and « Nombre de tâches » of each execution.
// A search creates that many tasks, one item each; work on linked records is one task per record (read-only).
export function MissionExecutionSection({ form }: { form: MissionFormApi }) {
  const { recurring, plan, targets } = form
  const split = !plan.fixed && Number(form.taskCount) >= plan.minimum ? taskSplit(Number(form.taskCount), targets) : []
  return (
    <section className="mission-form__section">
      <h3 className="mission-form__title">
        <ClockIcon size={18} /> Exécution
        <InfoTip label="Aide : exécution">
          Une mission active est accessible aux agents : ses tâches leur sont proposées dès sa création (ou à la date de
          démarrage), puis à chaque échéance si elle est récurrente. Une exécution impossible est notée en échec sur la
          mission, qui reste active.
        </InfoTip>
      </h3>
      <div className="mission-form__segmented" role="radiogroup" aria-label="Récurrence">
        {[
          { value: false, label: 'Une fois', icon: PlayIcon },
          { value: true, label: 'Récurrente', icon: RepeatIcon },
        ].map((option) => (
          <button
            key={option.label}
            type="button"
            role="radio"
            aria-checked={recurring === option.value}
            className={`mission-form__segment${recurring === option.value ? ' is-selected' : ''}`}
            onClick={() => {
              form.setRecurring(option.value)
            }}
          >
            <option.icon size={16} /> {option.label}
          </button>
        ))}
      </div>
      {recurring && (
        <div className="mission-form__row">
          <div className="mission-form__inline">
            <TextField
              label="Tous les"
              type="number"
              min={1}
              value={form.intervalCount}
              onChange={(event) => {
                form.setIntervalCount(Number(event.target.value))
              }}
            />
            <SelectField
              label="Unité"
              value={form.unit}
              onChange={(event) => {
                form.setUnit(event.target.value as RecurrenceUnit)
              }}
            >
              {UNITS.map((value) => (
                <option key={value} value={value}>
                  {UNIT_LABELS[value]}
                </option>
              ))}
            </SelectField>
          </div>
          <div className="mission-form__tipped">
            <TextField
              label="Démarrage"
              type="datetime-local"
              value={form.startsAt}
              onChange={(event) => {
                form.setStartsAt(event.target.value)
              }}
            />
            <span className="mission-form__tip">
              <InfoTip label="Aide : démarrage">Vide : la première exécution a lieu tout de suite.</InfoTip>
            </span>
          </div>
        </div>
      )}
      {recurring && (
        <div className="mission-form__row">
          <SelectField
            label="Fin"
            value={form.endKind}
            onChange={(event) => {
              form.setEndKind(event.target.value as MissionEndKind)
            }}
          >
            <option value="never">Jamais</option>
            <option value="date">À une date</option>
            <option value="after">Après X exécutions</option>
          </SelectField>
          {form.endKind === 'date' && (
            <TextField
              label="Date de fin"
              type="datetime-local"
              value={form.endsAt}
              onChange={(event) => {
                form.setEndsAt(event.target.value)
              }}
            />
          )}
          {form.endKind === 'after' && (
            <TextField
              label="Nombre d’exécutions"
              type="number"
              min={1}
              value={form.maxRuns}
              onChange={(event) => {
                form.setMaxRuns(event.target.value)
              }}
            />
          )}
        </div>
      )}
      <div className="mission-form__row">
        <div className="mission-form__tipped">
          <TextField
            label={recurring ? 'Nombre de tâches par exécution' : 'Nombre de tâches'}
            type="number"
            min={plan.fixed ? undefined : plan.minimum}
            max={TASK_COUNT_MAX}
            readOnly={plan.fixed}
            value={form.taskCount}
            onChange={(event) => {
              form.setTaskCount(event.target.value)
            }}
          />
          <span className="mission-form__tip">
            <InfoTip label="Aide : nombre de tâches">
              {plan.fixed
                ? `Fixé par les données liées : une tâche par ${plan.per}.`
                : 'Une tâche = un élément trouvé (société, entrepôt ou contact) : pour 50 prospects, 50 tâches, que les agents prennent en parallèle.'}
            </InfoTip>
          </span>
        </div>
      </div>
      {split.length > 1 && (
        <ul className="mission-form__split" aria-label="Répartition des tâches par société">
          {split.map((item, index) => (
            <li key={`${item.label}:${String(index)}`}>
              {item.label} <strong>{item.count}</strong>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
