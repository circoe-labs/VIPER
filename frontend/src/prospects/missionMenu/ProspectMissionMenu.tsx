import { type KeyboardEvent, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router'

import { ApiError } from '../../api/client'
import { useAssistantCapabilities } from '../../api/missionAssistant'
import { useMissionCategories } from '../../api/missionConfig'
import { type MissionDetail, useCreateMission } from '../../api/missions'
import { useReassessmentCommands } from '../../api/scoreReassessment'
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
  // The created mission's id (null until then); `reassessed` = it is the S4 reassessment, not a generic mission.
  const [created, setCreated] = useState<{ id: string | null; reassessed: boolean } | null>(null)
  const [localError, setLocalError] = useState<string | null>(null)
  const categories = useMissionCategories()
  const create = useCreateMission()
  const reassess = useReassessmentCommands(prospect.id).request

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
    reassess.reset()
  }

  // « Réanalyse son score »: S4's command (agent proposal reviewed under « Score prospect »), not a second mission shape.
  const reassessScore = () => {
    setLocalError(null)
    reassess.mutate(
      {},
      {
        onSuccess: (state) => {
          setCreated({ id: state.mission_id, reassessed: true })
        },
      },
    )
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
        setCreated({ id: mission.card.id, reassessed: false })
        onCreated?.(mission)
      },
    })
  }
  const error =
    localError ??
    (create.isError || reassess.isError
      ? (create.error ?? reassess.error) instanceof ApiError
        ? (create.error ?? reassess.error)?.message
        : 'La mission n’a pas pu être créée. Réessayez.'
      : categories.isError
        ? 'Les catégories de mission sont indisponibles. Réessayez dans un instant.'
        : null)
  const busy = create.isPending || reassess.isPending

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
            {created ? (
              <div className="pmm__done" role="status">
                <CheckCircleIcon size={20} />
                <div>
                  <strong>{created.reassessed ? 'Réévaluation demandée' : 'Mission créée'}</strong>
                  <p>
                    {created.reassessed
                      ? 'Un agent propose un score : suivez-la sous « Score prospect ».'
                      : 'Elle n’est pas lancée : lancez-la depuis sa page.'}
                  </p>
                  {created.id && (
                    <Link className="pmm__link" to={`/missions/${created.id}`} onClick={close}>
                      Ouvrir la mission
                    </Link>
                  )}
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
            {error && !created && (
              <p className="pmm__error" role="alert">
                {error}
              </p>
            )}
            {busy && (
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
