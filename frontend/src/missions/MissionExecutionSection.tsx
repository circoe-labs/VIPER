import type { MissionEndKind, RecurrenceUnit } from '../api/missions'
import { Checkbox, SelectField, TextField } from '../ui/fields'
import { ClockIcon, PlayIcon, RepeatIcon } from '../ui/icons'
import { InfoTip } from '../ui/InfoTip'
import { UNIT_LABELS } from './labels'
import type { MissionFormApi } from './useMissionForm'

const UNITS: RecurrenceUnit[] = ['hours', 'days', 'weeks', 'months']

// « Exécution »: one-off vs recurring (the existing recurrence fields) and the objective that says when the work is
// done. The objective is per run: a one-off mission closes when it is met; a recurring one gets a fresh objective at
// every interval and stays active until its recurrence ends.
export function MissionExecutionSection({ form }: { form: MissionFormApi }) {
  const { recurring, objective } = form
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
        <SelectField
          label={recurring ? 'Objectif de chaque exécution' : 'Objectif'}
          value={objective.kind}
          hint={
            recurring
              ? 'Chaque exécution repart d’un objectif neuf ; la mission reste active jusqu’à la fin de la récurrence.'
              : 'La mission se termine dès que son objectif est atteint.'
          }
          onChange={(event) => {
            form.setObjective(
              event.target.value === 'accepted_items'
                ? { kind: 'accepted_items', count: objective.count ?? 1 }
                : { kind: 'tasks_accepted', count: null },
            )
          }}
        >
          <option value="tasks_accepted">Toutes les tâches validées</option>
          <option value="accepted_items">Un nombre d’éléments validés</option>
        </SelectField>
        {objective.kind === 'accepted_items' && (
          <TextField
            label="Éléments à valider"
            type="number"
            min={1}
            max={Number(form.resultLimit) || undefined}
            value={objective.count ?? ''}
            hint="Compté à la validation par une personne ; au plus la limite par exécution."
            onChange={(event) => {
              form.setObjective({ kind: 'accepted_items', count: event.target.value ? Number(event.target.value) : null })
            }}
          />
        )}
      </div>
      <Checkbox
        label="Plusieurs éléments par envoi de l’agent"
        hint="Décoché : l’agent propose un seul élément à la fois."
        checked={form.allowMultiple}
        onChange={(event) => {
          form.setAllowMultiple(event.target.checked)
        }}
      />
    </section>
  )
}
