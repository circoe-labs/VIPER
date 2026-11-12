import { type KeyboardEvent, useRef, useState } from 'react'
import { useNavigate } from 'react-router'

import {
  type MissionDetail,
  type MissionEndKind,
  type MissionInput,
  type MissionResultKind,
  type RecurrenceUnit,
  type TargetOption,
  useCreateMission,
  useUpdateMission,
  useMissionAgents,
  useMissionOptions,
} from '../api/missions'
import { ApiError } from '../api/client'
import { Button } from '../ui/Button'
import { Modal } from '../ui/Dialog'
import { Checkbox, SelectField, TextAreaField, TextField } from '../ui/fields'
import {
  AlertIcon,
  BuildingIcon,
  CheckCircleIcon,
  ClockIcon,
  CloseIcon,
  LinkIcon,
  PlayIcon,
  PlusIcon,
  RepeatIcon,
  SlidersIcon,
  SparklesIcon,
  UsersIcon,
} from '../ui/icons'
import { InfoTip } from '../ui/InfoTip'
import { UNIT_LABELS } from './labels'
import { kindOf, kindSpec, MISSION_KINDS, type MissionKind, missingForRun } from './missionKinds'
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

// An ISO moment as a `datetime-local` value (the person's own clock), '' for none.
function localInput(iso: string | null): string {
  if (!iso) return ''
  const moment = new Date(iso)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${String(moment.getFullYear())}-${pad(moment.getMonth() + 1)}-${pad(moment.getDate())}T${pad(moment.getHours())}:${pad(moment.getMinutes())}`
}

const UNITS: RecurrenceUnit[] = ['hours', 'days', 'weeks', 'months']

interface MissionDialogProps {
  open: boolean
  onClose: () => void
  // « Modifier la mission »: the form starts from this mission and saves it in place. Mount the dialog when it
  // opens (the fields are initialised once).
  mission?: MissionDetail
  // Called after a successful edit (default: nothing more than closing).
  onSaved?: (detail: MissionDetail) => void
}

// « Que doit faire l’agent ? »: a radio group of tiles (arrows move the choice, Tab leaves the group). Each tile's
// explanation sits in an InfoTip beside it, not in plain text.
function KindTiles({ value, onChange }: { value: MissionKind; onChange: (kind: MissionKind) => void }) {
  const refs = useRef<(HTMLButtonElement | null)[]>([])
  const move = (event: KeyboardEvent, index: number) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key]
    if (step === undefined) return
    event.preventDefault()
    const next = (index + step + MISSION_KINDS.length) % MISSION_KINDS.length
    const target = MISSION_KINDS[next]
    if (!target) return
    onChange(target.id)
    refs.current[next]?.focus()
  }
  return (
    <div className="mission-kinds" role="radiogroup" aria-label="Que doit faire l’agent ?">
      {MISSION_KINDS.map((item, index) => {
        const selected = item.id === value
        return (
          <div key={item.id} className={`mission-kind${selected ? ' is-selected' : ''}`}>
            <button
              ref={(element) => {
                refs.current[index] = element
              }}
              type="button"
              role="radio"
              aria-checked={selected}
              tabIndex={selected ? 0 : -1}
              className="mission-kind__choice"
              onClick={() => {
                onChange(item.id)
              }}
              onKeyDown={(event) => {
                move(event, index)
              }}
            >
              <item.icon size={22} />
              <span className="mission-kind__label">{item.label}</span>
            </button>
            <span className="mission-kind__tip">
              <InfoTip label={`Aide : ${item.label}`}>{item.help}</InfoTip>
            </span>
          </div>
        )
      })}
    </div>
  )
}

// « + Nouvelle mission » / « Modifier la mission »: the tiles, the consigne, the linked data, the run, then the
// advanced block; a live line says whether the rule can run. The linked records are
export function CreateMissionDialog({ open, onClose, mission, onSaved }: MissionDialogProps) {
  const navigate = useNavigate()
  const create = useCreateMission()
  const update = useUpdateMission(mission?.card.id ?? '')
  const editing = mission !== undefined
  const saving = editing ? update : create
  const options = useMissionOptions()
  const agents = useMissionAgents()
  const card = mission?.card
  const rule = mission?.rule
  const [name, setName] = useState(card?.name ?? '')
  const [kind, setKind] = useState<MissionKind>(mission ? kindOf(mission.card.type, mission.result_kind) : 'enrich')
  const [agentId, setAgentId] = useState(rule?.agent_id ?? '')
  const [prompt, setPrompt] = useState(mission?.prompt ?? '')
  const [targets, setTargets] = useState<TargetOption[]>(
    mission?.targets.map((target) => ({ kind: target.kind, id: target.id, label: target.label, hint: target.hint })) ?? [],
  )
  const [recurring, setRecurring] = useState(card?.is_recurring ?? false)
  const [intervalCount, setIntervalCount] = useState(card?.interval_count ?? 24)
  const [unit, setUnit] = useState<RecurrenceUnit>(card?.interval_unit ?? 'hours')
  const [startsAt, setStartsAt] = useState(localInput(rule?.starts_at ?? null))
  const [endKind, setEndKind] = useState<MissionEndKind>(rule?.end_kind ?? 'never')
  const [endsAt, setEndsAt] = useState(localInput(rule?.ends_at ?? null))
  const [maxRuns, setMaxRuns] = useState(String(rule?.max_runs ?? 10))
  // The tile sets the expected result; an edited mission keeps its own while its tile stays the same.
  const [resultKind, setResultKind] = useState<MissionResultKind>(mission?.result_kind ?? 'enrichment')
  const [resultLimit, setResultLimit] = useState(String(mission?.result_limit ?? 20))
  const [geography, setGeography] = useState(rule?.geography ?? '')
  const [periodDays, setPeriodDays] = useState(rule?.period_days ? String(rule.period_days) : '')
  const [excludeKnown, setExcludeKnown] = useState(rule?.exclusions.known_companies === true)
  const [nameTouched, setNameTouched] = useState(editing)
  const [picking, setPicking] = useState(false)

  const spec = kindSpec(kind)
  const type = spec.type
  const executable =
    (options.data?.types.find((item) => item.value === type)?.executable ?? true) &&
    (options.data?.result_kinds.find((item) => item.value === resultKind)?.executable ?? true)
  const filled = name.trim() !== '' && prompt.trim() !== ''
  // Mirrors the server: a rule that could never produce a task is not saved (it used to be, then sat paused).
  const missing = executable
    ? missingForRun(type, resultKind, targets)
    : 'Ce type de mission n’est pas encore exécutable : choisissez-en un autre.'
  const ready = missing === null
  const canSave = filled && ready

  const chooseKind = (next: MissionKind) => {
    setKind(next)
    setResultKind(kindSpec(next).resultKind)
  }

  const close = () => {
    setPicking(false)
    onClose()
  }

  const submit = () => {
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
      exclusions: { ...(rule?.exclusions ?? {}), known_companies: excludeKnown },
      run_now: false,
    }
    if (!excludeKnown) delete input.exclusions.known_companies
    if (editing) {
      update.mutate(input, {
        onSuccess: (detail) => {
          close()
          onSaved?.(detail)
        },
      })
      return
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
      title={editing ? 'Modifier la mission' : 'Nouvelle mission'}
      footer={
        editing ? (
          <div className="mission-form__footer">
            <Button variant="secondary" onClick={close}>
              Annuler
            </Button>
            <Button
              variant="primary"
              disabled={!canSave || update.isPending}
              loading={update.isPending}
              onClick={() => {
                submit()
              }}
            >
              Enregistrer
            </Button>
          </div>
        ) : (
          <div className="mission-form__footer">
            <Button variant="secondary" onClick={close}>
              Annuler
            </Button>
            <Button
              variant="primary"
              disabled={!canSave || create.isPending}
              loading={create.isPending}
              onClick={() => {
                submit()
              }}
            >
              Créer la mission
            </Button>
          </div>
        )
      }
    >
      <div className="mission-form">
        <section className="mission-form__section">
          <h3 className="mission-form__title">
            <SparklesIcon size={18} /> Que doit faire l’agent ?
            <InfoTip label="Aide : que doit faire l’agent ?">
              Une consigne, des données VIPER, une exécution. Les agents proposent ; rien n’est écrit dans la base sans
              votre validation.
            </InfoTip>
          </h3>
          <KindTiles value={kind} onChange={chooseKind} />
        </section>

        <section className="mission-form__section">
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
          <div className="mission-form__row">
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
            <div className="mission-form__tipped">
              <SelectField
                label="Agent"
                value={agentId}
                onChange={(event) => {
                  setAgentId(event.target.value)
                }}
              >
                <option value="">Automatique</option>
                {(agents.data ?? []).map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.label}
                  </option>
                ))}
              </SelectField>
              <span className="mission-form__tip">
                <InfoTip label="Aide : agent">
                  Automatique : le premier agent connecté (Claude, ChatGPT…) qui sait exécuter ce type prend les tâches.
                  Choisissez un agent pour lui réserver la mission.
                </InfoTip>
              </span>
            </div>
          </div>
        </section>

        <section className="mission-form__section">
          <h3 className="mission-form__title">
            <LinkIcon size={18} /> Données liées <span className="mission-form__count">{targets.length || ''}</span>
            <InfoTip label="Aide : données liées">
              Sociétés ou prospects déjà dans VIPER. La mission garde leur référence : l’agent relit la fiche à jour à
              chaque exécution.
            </InfoTip>
          </h3>
          {targets.length > 0 && (
            <ul className="mission-targets">
              {targets.map((target) => {
                const KindIcon = target.kind === 'company' ? BuildingIcon : UsersIcon
                return (
                  <li key={targetKey(target)} className="mission-target">
                    <span
                      className="mission-target__icon"
                      role="img"
                      aria-label={target.kind === 'company' ? 'Société' : 'Prospect'}
                    >
                      <KindIcon size={14} />
                    </span>
                    <span className="mission-target__label">{target.label}</span>
                    <button
                      type="button"
                      className="mission-target__remove"
                      aria-label={`Retirer ${target.label}`}
                      onClick={() => {
                        setTargets(targets.filter((item) => targetKey(item) !== targetKey(target)))
                      }}
                    >
                      <CloseIcon size={14} />
                    </button>
                  </li>
                )
              })}
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
        </section>

        <section className="mission-form__section">
          <h3 className="mission-form__title">
            <ClockIcon size={18} /> Exécution
            <InfoTip label="Aide : exécution">
              Une mission active est accessible aux agents : ses tâches leur sont proposées dès sa création (ou à la
              date de démarrage), puis à chaque échéance si elle est récurrente. Une exécution impossible est notée en échec sur la mission,
              qui reste active.
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
                  setRecurring(option.value)
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
              <div className="mission-form__tipped">
                <TextField
                  label="Démarrage"
                  type="datetime-local"
                  value={startsAt}
                  onChange={(event) => {
                    setStartsAt(event.target.value)
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
                value={endKind}
                onChange={(event) => {
                  setEndKind(event.target.value as MissionEndKind)
                }}
              >
                <option value="never">Jamais</option>
                <option value="date">À une date</option>
                <option value="after">Après X exécutions</option>
              </SelectField>
              {endKind === 'date' && (
                <TextField
                  label="Date de fin"
                  type="datetime-local"
                  value={endsAt}
                  onChange={(event) => {
                    setEndsAt(event.target.value)
                  }}
                />
              )}
              {endKind === 'after' && (
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
            </div>
          )}
        </section>

        <details className="mission-form__advanced">
          <summary>
            <SlidersIcon size={16} /> Options avancées
          </summary>
          <div className="mission-form__row">
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

        <p className={`mission-form__ready${ready ? ' is-ready' : ''}`} role="status">
          {ready ? <CheckCircleIcon size={18} /> : <AlertIcon size={18} />}
          {ready ? (recurring ? 'Prête : elle s’exécutera à chaque échéance.' : 'Prête à être lancée.') : missing}
        </p>

        {saving.isError && (
          <p className="missions-error" role="alert">
            {saving.error instanceof ApiError
              ? saving.error.message
              : editing
                ? 'La mission n’a pas pu être enregistrée.'
                : 'La mission n’a pas pu être créée.'}
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
        }}
      />
    </Modal>
  )
}
