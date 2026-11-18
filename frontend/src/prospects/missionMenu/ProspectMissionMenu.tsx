import { type KeyboardEvent, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router'

import { ApiError } from '../../api/client'
import { useAssistantCapabilities } from '../../api/missionAssistant'
import { useMissionCategories } from '../../api/missionConfig'
import { type MissionDetail, useCreateMission } from '../../api/missions'
import { type EvaluationState, evaluationFailure, useEvaluateScore, useEvaluationState } from '../../api/scoreEvaluation'
import { chooseSpeechMode, type SpeechMode, useSpeechInput } from '../../missions/voice/useSpeechInput'
import { Button } from '../../ui/Button'
import { TextAreaField } from '../../ui/fields'
import {
  CheckCircleIcon,
  CloseIcon,
  CompassIcon,
  MicIcon,
  MoreIcon,
  PencilIcon,
  SparklesIcon,
  type IconComponent,
  TargetIcon,
  UsersIcon,
} from '../../ui/icons'
import { Popover } from '../../ui/Popover'
import { buildProspectMission, type MissionPreset, type MissionProspect, PRESETS, REASSESS_TILE } from './prospectMissionFactory'
import './prospect-mission-menu.css'

type TileId = MissionPreset | typeof REASSESS_TILE.id

const PRESET_ICONS: Record<TileId, IconComponent> = {
  complete: PencilIcon,
  reassess: CompassIcon,
  relations: UsersIcon,
  other: MoreIcon,
}

interface Props {
  // The prospect the mission is bound to (real `prospect_id` target). Map it from the editor's loaded prospect.
  prospect: MissionProspect
  // Called once a mission is created (it is never started automatically).
  onCreated?: (mission: MissionDetail) => void
  className?: string
  // Bumped by the sheet (context menu « Mission ») to open the popover as if the button had been pressed.
  openRequest?: number
}

// « Mission » button of the prospect header + its compact popover: 2x2 shortcuts (arrow keys move, Enter chooses,
// Esc closes) and « Autre » (typed or dictated request). Creating a mission only saves it; the success line links
// to its detail page.
export function ProspectMissionMenu({ prospect, onCreated, className, openRequest = 0 }: Props) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const button = useRef<HTMLButtonElement>(null)
  const seenRequest = useRef(openRequest)
  const [mode, setMode] = useState<'menu' | 'other'>('menu')
  // The created mission's id (null until then).
  const [created, setCreated] = useState<{ id: string } | null>(null)
  // « Réanalyse son score » was chosen: the popover follows the evaluation (it is not a mission).
  const [evaluating, setEvaluating] = useState(false)
  const [localError, setLocalError] = useState<string | null>(null)
  const categories = useMissionCategories()
  const create = useCreateMission()
  const evaluate = useEvaluateScore(prospect.id)
  const evaluation = useEvaluationState(prospect.id)

  useEffect(() => {
    if (openRequest === seenRequest.current) return
    seenRequest.current = openRequest
    // After the context menu has closed and given the focus back.
    const frame = requestAnimationFrame(() => {
      setAnchor(button.current)
    })
    return () => {
      cancelAnimationFrame(frame)
    }
  }, [openRequest])

  const close = () => {
    setAnchor(null)
    setMode('menu')
    setCreated(null)
    create.reset()
    setEvaluating(false)
  }

  // « Réanalyse son score »: the AI scores the sheet directly (POST /prospects/{id}/score/evaluate, seconds); the card
  // « Score prospect » shows the same progress. Not a mission.
  const reassessScore = () => {
    setLocalError(null)
    setEvaluating(true)
    evaluate.start()
  }

  const submit = (preset: MissionPreset, request = '') => {
    const built = buildProspectMission(preset, prospect, categories.data ?? [], request)
    if (!built.ok) {
      create.reset()
      setLocalError(built.error)
      return
    }
    setLocalError(null)
    create.mutate(built.input, {
      onSuccess: (mission) => {
        setCreated({ id: mission.card.id })
        onCreated?.(mission)
      },
    })
  }
  const error =
    localError ??
    (create.isError
      ? create.error instanceof ApiError
        ? create.error.message
        : 'La mission n’a pas pu être créée. Réessayez.'
      : categories.isError
        ? 'Les catégories de mission sont indisponibles. Réessayez dans un instant.'
        : null)
  const busy = create.isPending || evaluate.isPending

  return (
    <>
      <Button
        ref={button}
        variant="secondary"
        icon={TargetIcon}
        className={className}
        aria-haspopup="dialog"
        aria-expanded={anchor !== null}
        onClick={(event) => {
          if (anchor) close()
          else setAnchor(event.currentTarget)
        }}
      >
        Mission
      </Button>
      {anchor && (
        <Popover anchor={anchor} label="Mission pour ce prospect" onClose={close} alignRight>
          <div className="pmm">
            {evaluating ? (
              <EvaluationProgress state={evaluation} onClose={close} />
            ) : created ? (
              <div className="pmm__done" role="status">
                <CheckCircleIcon size={20} />
                <div>
                  <strong>Mission créée</strong>
                  <p>Elle n’est pas lancée : lancez-la depuis sa page.</p>
                  <Link className="pmm__link" to={`/missions/${created.id}`} onClick={close}>
                    Ouvrir la mission
                  </Link>
                </div>
              </div>
            ) : mode === 'menu' ? (
              <PresetGrid disabled={busy || categories.isPending} onPreset={submit} onReassess={reassessScore} onOther={() => { setMode('other') }} />
            ) : (
              <OtherRequest
                busy={busy}
                onBack={() => {
                  setMode('menu')
                  setLocalError(null)
                  create.reset()
                }}
                onSubmit={(text) => { submit('other', text) }}
              />
            )}
            {error && !created && !evaluating && (
              <p className="pmm__error" role="alert">
                {error}
              </p>
            )}
            {create.isPending && (
              <p className="pmm__busy" role="status">
                Création de la mission…
              </p>
            )}
          </div>
        </Popover>
      )}
    </>
  )
}

function PresetGrid({
  disabled,
  onPreset,
  onReassess,
  onOther,
}: {
  disabled: boolean
  onPreset: (preset: MissionPreset) => void
  onReassess: () => void
  onOther: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const spec = (id: Exclude<MissionPreset, 'other'>) => PRESETS.find((item) => item.id === id)
  const choices: { id: TileId; label: string; hint: string }[] = [
    ...[spec('complete'), REASSESS_TILE, spec('relations')].flatMap((tile) => (tile ? [tile] : [])),
    { id: 'other', label: 'Autre', hint: 'Votre demande, écrite ou dictée' },
  ]

  // 2x2 grid: arrows move by cell, Home/End jump.
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const cells = [...(ref.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])]
    const at = cells.indexOf(document.activeElement as HTMLButtonElement)
    if (at < 0) return
    const next = { ArrowRight: at + 1, ArrowLeft: at - 1, ArrowDown: at + 2, ArrowUp: at - 2, Home: 0, End: cells.length - 1 }[
      event.key
    ]
    if (next === undefined || next < 0 || next >= cells.length) return
    event.preventDefault()
    cells[next]?.focus()
  }

  return (
    <div ref={ref} className="pmm__grid" role="group" aria-label="Choisir une mission" onKeyDown={onKeyDown}>
      {choices.map((choice) => {
        const Icon = PRESET_ICONS[choice.id]
        return (
          <button
            key={choice.id}
            type="button"
            className="pmm__tile"
            disabled={disabled && choice.id !== 'other'}
            onClick={() => {
              if (choice.id === 'other') onOther()
              else if (choice.id === 'reassess') onReassess()
              else onPreset(choice.id)
            }}
          >
            <Icon size={20} className="pmm__tile-icon" />
            <span className="pmm__tile-label">{choice.label}</span>
            <span className="pmm__tile-hint">{choice.hint}</span>
          </button>
        )
      })}
    </div>
  )
}

function safeSpeechMode(server: boolean): SpeechMode {
  try {
    return chooseSpeechMode(server)
  } catch {
    // No `navigator.mediaDevices` (insecure context): typing only.
    return 'none'
  }
}

function OtherRequest({ busy, onBack, onSubmit }: { busy: boolean; onBack: () => void; onSubmit: (text: string) => void }) {
  const [text, setText] = useState('')
  const capabilities = useAssistantCapabilities()
  // Capabilities pending/failed: the browser's own recognition is still tried, else typed text only.
  const mode = safeSpeechMode(capabilities.data?.speech ?? false)
  const speech = useSpeechInput({
    mode,
    onLevel: () => undefined,
    onFinal: (heard) => {
      setText((current) => (current.trim() ? `${current.trim()} ${heard}` : heard))
    },
  })
  const seconds = useElapsed(speech.state !== 'idle')
  const micOff = mode === 'none'
  const listening = speech.state === 'listening'
  const status =
    speech.state === 'transcribing'
      ? 'Transcription…'
      : listening
        ? `Écoute… ${String(seconds)} s — touchez le micro pour terminer`
        : null

  return (
    <form
      className="pmm__other"
      onSubmit={(event) => {
        event.preventDefault()
        speech.stop()
        onSubmit(text)
      }}
    >
      <TextAreaField
        label="Que doit faire l’agent ?"
        rows={4}
        value={speech.partial ? `${text}${text ? ' ' : ''}${speech.partial}` : text}
        readOnly={speech.partial !== ''}
        placeholder="Ex. : trouve son rôle exact dans l’organisation"
        onChange={(event) => { setText(event.target.value) }}
        autoFocus
      />
      <div className="pmm__row">
        <Button
          variant={listening ? 'primary' : 'secondary'}
          size="sm"
          icon={MicIcon}
          aria-pressed={listening}
          disabled={micOff || speech.state === 'transcribing'}
          title={micOff ? 'Dictée indisponible sur ce navigateur : écrivez votre demande.' : undefined}
          onClick={() => {
            if (listening) speech.finish()
            else void speech.start()
          }}
        >
          {listening ? 'Terminer' : 'Dicter'}
        </Button>
        {status && (
          <span className="pmm__status" role="status">
            {status}
          </span>
        )}
      </div>
      {micOff && (
        <p className="pmm__hint">La dictée n’est pas disponible ici ; écrivez votre demande.</p>
      )}
      {speech.error && (
        <p className="pmm__error" role="alert">
          {speech.error}
        </p>
      )}
      <div className="pmm__actions">
        <Button variant="ghost" size="sm" icon={CloseIcon} onClick={onBack}>
          Retour
        </Button>
        <Button type="submit" variant="primary" size="sm" loading={busy} disabled={text.trim() === ''}>
          Créer la mission
        </Button>
      </div>
    </form>
  )
}

// Live seconds while `running` (Rule Zero: a waiting state shows how long it has lasted).
function useElapsed(running: boolean): number {
  const [seconds, setSeconds] = useState(0)
  useEffect(() => {
    if (!running) return
    const started = Date.now()
    const timer = window.setInterval(() => {
      setSeconds(Math.floor((Date.now() - started) / 1000))
    }, 500)
    return () => {
      window.clearInterval(timer)
      setSeconds(0)
    }
  }, [running])
  return running ? seconds : 0
}

// « Réanalyse son score »: what the popover says while the AI works, then the outcome (the card says it too). The tile that
// was pressed is gone, so the block takes the focus: Esc then closes the popover only (the Popover listens on its content),
// never the sheet behind it.
function EvaluationProgress({ state, onClose }: { state: EvaluationState; onClose: () => void }) {
  const elapsed = useElapsed(state.status === 'pending')
  const holder = useRef<HTMLDivElement>(null)
  useEffect(() => {
    holder.current?.focus()
  }, [])
  const done = state.status === 'success'
  return (
    <div ref={holder} className="pmm__eval" tabIndex={-1}>
      {state.status === 'error' ? (
        <p className="pmm__error" role="alert">
          {evaluationFailure(state.error)} Score inchangé.
        </p>
      ) : (
        <div className="pmm__done" role="status">
          {done ? <CheckCircleIcon size={20} /> : <SparklesIcon size={20} />}
          <div>
            <strong>{done ? 'Score mis à jour' : 'Évaluation en cours…'}</strong>
            <p>{done ? 'Le détail est sous « Score prospect ».' : `L’IA analyse la fiche · ${String(elapsed)} s`}</p>
            {done && (
              <button type="button" className="pmm__link" onClick={onClose}>
                Fermer
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
