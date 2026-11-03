import { useState } from 'react'
import { useNavigate } from 'react-router'

import {
  type MissionEndKind,
  type MissionInput,
  type MissionResultKind,
  type MissionType,
  type RecurrenceUnit,
  type TargetOption,
  useCreateMission,
  useMissionAgents,
  useMissionOptions,
} from '../api/missions'
import { ApiError } from '../api/client'
import { Button } from '../ui/Button'
import { Modal } from '../ui/Dialog'
import { Checkbox, SelectField, TextAreaField, TextField } from '../ui/fields'
import { PlusIcon } from '../ui/icons'
import { MISSION_TYPE_LABELS, RESULT_KIND_LABELS, UNIT_LABELS } from './labels'
import { TargetPicker } from './TargetPicker'

function suggestion(prompt: string): string {
  const first = prompt.trim().split('\n')[0] ?? ''
  const cleaned = first.replace(/[.;:,]+$/, '').trim()
  if (cleaned.length <= 60) return cleaned
  return `${cleaned.slice(0, 57)}…`
}

function targetKey(target: TargetOption): string {
  return `${target.kind}:${target.id}`
}

const TYPES: MissionType[] = ['prospection', 'signals', 'enrichment', 'verification', 'other']
const UNITS: RecurrenceUnit[] = ['hours', 'days', 'weeks', 'months']

// « + Nouvelle mission »: six visible fields, then the advanced block. The linked records are chips
// (references), and the consigne stays the agent's main instruction.
export function CreateMissionDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate()
  const create = useCreateMission()
  const options = useMissionOptions()
  const agents = useMissionAgents()
  const [name, setName] = useState('')
  const [type, setType] = useState<MissionType>('enrichment')
  const [agentId, setAgentId] = useState('')
  const [prompt, setPrompt] = useState('')
  const [targets, setTargets] = useState<TargetOption[]>([])
  const [recurring, setRecurring] = useState(false)
  const [intervalCount, setIntervalCount] = useState(24)
  const [unit, setUnit] = useState<RecurrenceUnit>('hours')
  const [startsAt, setStartsAt] = useState('')
  const [endKind, setEndKind] = useState<MissionEndKind>('never')
  const [endsAt, setEndsAt] = useState('')
  const [maxRuns, setMaxRuns] = useState('10')
  const [resultKind, setResultKind] = useState<MissionResultKind>('enrichment')
  const [resultLimit, setResultLimit] = useState('20')
  const [geography, setGeography] = useState('')
  const [periodDays, setPeriodDays] = useState('')
  const [excludeKnown, setExcludeKnown] = useState(false)
  const [nameTouched, setNameTouched] = useState(false)
  const [picking, setPicking] = useState(false)

  const executable = options.data?.types.find((item) => item.value === type)?.executable ?? type === 'enrichment'
  const canCreate = name.trim() !== '' && prompt.trim() !== ''
  const companyTargets = targets.filter((target) => target.kind === 'company').length
  // A prospection without linked companies is a discovery (new companies); with companies it
  // looks for new contacts. The expected result follows the two modes.
  const prospectable =
    type === 'signals'
      ? companyTargets > 0 && resultKind === 'signals'
      : type === 'prospection'
        ? (targets.length === 0 && resultKind === 'companies') ||
          (companyTargets > 0 && resultKind === 'prospects')
        : targets.length > 0
  const canRun = canCreate && executable && prospectable
  const resultOptions = (options.data?.result_kinds ?? []).map((item) => ({
    value: item.value,
    label: `${RESULT_KIND_LABELS[item.value as MissionResultKind]}${item.executable ? '' : ' (bientôt)'}`,
  }))

  const close = () => {
    setPicking(false)
    onClose()
  }

  const submit = (runNow: boolean) => {
    const input: MissionInput = {
      name: name.trim(),
      type,
      prompt: prompt.trim(),
      targets: targets.map((target) => ({ kind: target.kind, id: target.id })),
      agent_id: agentId || null,
      is_recurring: recurring,
      interval_count: intervalCount,
      interval_unit: unit,
      starts_at: startsAt ? new Date(startsAt).toISOString() : null,
      end_kind: recurring ? endKind : 'never',
      ends_at: recurring && endKind === 'date' && endsAt ? new Date(endsAt).toISOString() : null,
      max_runs: recurring && endKind === 'after' ? Number(maxRuns) : null,
      result_kind: resultKind,
      result_limit: Number(resultLimit),
      geography: geography.trim() || null,
      period_days: periodDays ? Number(periodDays) : null,
      exclusions: excludeKnown ? { known_companies: true } : {},
      run_now: runNow,
    }
    create.mutate(input, {
      onSuccess: (detail) => {
        close()
        void navigate(`/missions/${detail.card.id}`)
      },
    })
  }

  return (
    <Modal
      open={open}
      onClose={close}
      size="lg"
      title="Nouvelle mission"
      description="Une consigne, des données VIPER, une exécution. Rien n’est écrit dans la base sans votre validation."
      footer={
        <div className="mission-form__footer">
          <Button variant="secondary" onClick={close}>
            Annuler
          </Button>
          <Button
            variant="secondary"
            disabled={!canCreate || create.isPending}
            onClick={() => {
              submit(false)
            }}
          >
            Créer la mission
          </Button>
          <Button
            variant="primary"
            disabled={!canRun || create.isPending}
            loading={create.isPending}
            onClick={() => {
              submit(true)
            }}
          >
            Créer et lancer
          </Button>
        </div>
      }
    >
      <div className="mission-form">
        <section className="mission-form__section">
          <h3 className="mission-form__title">Mission</h3>
          <TextField
            label="Nom"
            value={name}
            onChange={(event) => {
              setNameTouched(true)
              setName(event.target.value)
            }}
            placeholder="Nouveaux entrepôts — Normandie"
            required
          />
          <div className="mission-form__row">
            <SelectField
              label="Type"
              value={type}
              onChange={(event) => {
                const next = event.target.value as MissionType
                setType(next)
                if (next === 'signals') setResultKind('signals')
                if (next === 'prospection') {
                  setResultKind(targets.length > 0 ? 'prospects' : 'companies')
                }
              }}
            >
              {TYPES.map((value) => {
                const enabled = options.data?.types.find((item) => item.value === value)?.executable ?? value === 'enrichment'
                return (
                  <option key={value} value={value}>
                    {MISSION_TYPE_LABELS[value]}
                    {enabled ? '' : ' (bientôt)'}
                  </option>
                )
              })}
            </SelectField>
            <SelectField
              label="Agent"
              value={agentId}
              onChange={(event) => {
                setAgentId(event.target.value)
              }}
              hint="Automatique : le premier agent disponible qui sait exécuter ce type."
            >
              <option value="">Automatique</option>
              {(agents.data ?? []).map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.label}
                </option>
              ))}
            </SelectField>
          </div>
          <TextAreaField
            label="Consigne"
            value={prompt}
            rows={4}
            onChange={(event) => {
              setPrompt(event.target.value)
              if (!nameTouched) setName(suggestion(event.target.value))
            }}
            placeholder="Complète ces fiches avec le site web, le domaine e-mail et les coordonnées professionnelles disponibles."
            required
          />
        </section>

        <section className="mission-form__section">
          <h3 className="mission-form__title">
            Données liées <span className="mission-form__count">{targets.length || ''}</span>
          </h3>
          {targets.length > 0 && (
            <ul className="mission-targets">
              {targets.map((target) => (
                <li key={targetKey(target)} className="mission-target">
                  <span className="mission-target__kind">{target.kind === 'company' ? 'Société' : 'Prospect'}</span>
                  <span className="mission-target__label">{target.label}</span>
                  <button
                    type="button"
                    className="mission-target__remove"
                    aria-label={`Retirer ${target.label}`}
                    onClick={() => {
                      const next = targets.filter((item) => targetKey(item) !== targetKey(target))
                      setTargets(next)
                      if (next.length === 0 && type === 'prospection') setResultKind('companies')
                    }}
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}
          <Button
            variant="secondary"
            size="sm"
            icon={PlusIcon}
            onClick={() => {
              setPicking(true)
            }}
          >
            Ajouter des données
          </Button>
          <p className="mission-form__hint">
            Sociétés ou prospects déjà dans VIPER. La mission garde leur référence : l’agent relit la fiche à jour.
          </p>
        </section>

        <section className="mission-form__section">
          <h3 className="mission-form__title">Exécution</h3>
          <div className="mission-form__row">
            <SelectField
              label="Récurrence"
              value={recurring ? 'recurring' : 'once'}
              onChange={(event) => {
                setRecurring(event.target.value === 'recurring')
              }}
            >
              <option value="once">Ponctuelle</option>
              <option value="recurring">Récurrente</option>
            </SelectField>
            {recurring && (
              <div className="mission-form__inline">
                <TextField
                  label="Tous les"
                  type="number"
                  min={1}
                  value={intervalCount}
                  onChange={(event) => {
                    setIntervalCount(Number(event.target.value))
                  }}
                />
                <SelectField
                  label="Unité"
                  value={unit}
                  onChange={(event) => {
                    setUnit(event.target.value as RecurrenceUnit)
                  }}
                >
                  {UNITS.map((value) => (
                    <option key={value} value={value}>
                      {UNIT_LABELS[value]}
                    </option>
                  ))}
                </SelectField>
              </div>
            )}
          </div>
          {recurring && (
            <div className="mission-form__row">
              <TextField
                label="Démarrage"
                type="datetime-local"
                value={startsAt}
                onChange={(event) => {
                  setStartsAt(event.target.value)
                }}
                hint="Vide = maintenant."
              />
              <SelectField
                label="Fin"
                value={endKind}
                onChange={(event) => {
                  setEndKind(event.target.value as MissionEndKind)
                }}
              >
                <option value="never">Jamais</option>
                <option value="date">À une date</option>
                <option value="after">Après X exécutions</option>
              </SelectField>
            </div>
          )}
          {recurring && endKind === 'date' && (
            <TextField
              label="Date de fin"
              type="datetime-local"
              value={endsAt}
              onChange={(event) => {
                setEndsAt(event.target.value)
              }}
            />
          )}
          {recurring && endKind === 'after' && (
            <TextField
              label="Nombre d’exécutions"
              type="number"
              min={1}
              value={maxRuns}
              onChange={(event) => {
                setMaxRuns(event.target.value)
              }}
            />
          )}
        </section>

        <details className="mission-form__advanced">
          <summary>Options avancées</summary>
          <div className="mission-form__row">
            <SelectField
              label="Résultat attendu"
              value={resultKind}
              onChange={(event) => {
                setResultKind(event.target.value as MissionResultKind)
              }}
            >
              {resultOptions.length === 0 && <option value="enrichment">Informations complétant les fiches</option>}
              {resultOptions.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
            </SelectField>
            <TextField
              label="Limite par exécution"
              type="number"
              min={1}
              max={options.data?.result_limit_max ?? 500}
              value={resultLimit}
              onChange={(event) => {
                setResultLimit(event.target.value)
              }}
            />
          </div>
          <div className="mission-form__row">
            <TextField
              label="Zone géographique"
              value={geography}
              onChange={(event) => {
                setGeography(event.target.value)
              }}
              placeholder="Normandie, France, département…"
            />
            <SelectField
              label="Période recherchée"
              value={periodDays}
              onChange={(event) => {
                setPeriodDays(event.target.value)
              }}
            >
              <option value="">Indifférente</option>
              <option value="7">7 derniers jours</option>
              <option value="30">30 derniers jours</option>
              <option value="90">90 derniers jours</option>
            </SelectField>
          </div>
          <Checkbox
            label="Ignorer les sociétés déjà connues"
            checked={excludeKnown}
            onChange={(event) => {
              setExcludeKnown(event.target.checked)
            }}
          />
        </details>

        {create.isError && (
          <p className="missions-error">
            {create.error instanceof ApiError ? create.error.message : 'La mission n’a pas pu être créée.'}
          </p>
        )}
        {!executable && (
          <p className="mission-form__notice">
            Ce type de mission n’est pas encore exécutable : vous pouvez l’enregistrer, l’exécution viendra avec les
            schémas de résultat.
          </p>
        )}
      </div>
      <TargetPicker
        open={picking}
        onClose={() => {
          setPicking(false)
        }}
        onAdd={(added) => {
          const seen = new Set(targets.map(targetKey))
          const next = [...targets, ...added.filter((target) => !seen.has(targetKey(target)))]
          setTargets(next)
          if (next.length > 0 && type === 'prospection') setResultKind('prospects')
        }}
      />
    </Modal>
  )
}
