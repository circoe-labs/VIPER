import { useState } from 'react'
import { Link } from 'react-router'

import { type HumanizerCheck, type HumanizerDefaults, useHumanizerCheck } from '../api/contact'
import { useIntegrations, useIntegrationsMutations } from '../api/integrations'
import { Button } from '../ui/Button'
import { Modal } from '../ui/Dialog'
import { Switch, TextAreaField } from '../ui/fields'
import { AlertIcon, CheckCircleIcon, ShieldCheckIcon } from '../ui/icons'
import { InfoTip } from '../ui/InfoTip'
import { Segmented, type SegmentedOption } from '../ui/Segmented'
import {
  type AiInstruction,
  type AiSender,
  type AiTone,
  formatCount,
  INSTRUCTION_MAX_LENGTH,
  SENDER_EXAMPLES,
  TONE_LEVELS,
  TONE_MEANINGS,
} from './aiDraftModel'
import { refusalOf } from './messages'

type ToneChoice = 'auto' | `${AiTone}`
type SenderChoice = 'auto' | AiSender

const TONE_OPTIONS: SegmentedOption<ToneChoice>[] = [
  { value: 'auto', label: 'Auto', title: 'Selon la proximité avec le contact' },
  ...TONE_LEVELS.map((level) => ({
    value: String(level) as ToneChoice,
    label: String(level),
    title: level === 0 ? TONE_MEANINGS.low : level === 5 ? TONE_MEANINGS.high : `Niveau ${String(level)} sur 5`,
  })),
]

const SENDER_OPTIONS: SegmentedOption<SenderChoice>[] = [
  { value: 'auto', label: 'Auto', title: 'Selon la proximité avec le contact' },
  { value: 'ai', label: SENDER_EXAMPLES.ai.label, title: SENDER_EXAMPLES.ai.example },
  { value: 'person', label: SENDER_EXAMPLES.person.label, title: SENDER_EXAMPLES.person.example },
]

// The refusals of `POST /contact/humanizer-check`: `humanizer_unavailable` carries the reason (the HumanGPT `humanizer_*` code).
const CHECK_REASONS: Record<string, string> = {
  humanizer_not_configured: 'Aucune clé HumanGPT enregistrée (Config AI › Humanizer).',
  humanizer_auth_failed: 'HumanGPT refuse la clé enregistrée (Config AI › Humanizer).',
  humanizer_quota_exceeded: 'Le quota HumanGPT du compte est épuisé.',
  humanizer_rate_limited: 'HumanGPT limite les appels : réessayez dans un instant.',
}

function checkFailure(error: unknown): string {
  const refusal = refusalOf(error)
  if (refusal?.reason && refusal.reason in CHECK_REASONS) return CHECK_REASONS[refusal.reason] ?? ''
  if (refusal?.code === 'humanizer_unavailable') return 'HumanGPT est injoignable : réessayez dans un instant.'
  if (refusal?.code === 'invalid') return 'Il n’y a pas de texte à vérifier.'
  return 'Le contrôle n’a pas abouti : réessayez.'
}

interface AdvancedSettingsProps {
  open: boolean
  onClose: () => void
  stepLabel: string
  idPrefix: string
  instruction: AiInstruction
  onInstruction: (instruction: AiInstruction) => void
  running: boolean
  // The mail's text as it stands (the humanizer reads it); empty = nothing to check.
  body: string
  humanizer: HumanizerDefaults | undefined
}

// « Paramètres avancés » of the AI drafting: extra instructions, tone, sender, and the humanizer (the HumanGPT score a
// message must reach before it can be validated). Instruction, tone and sender stay with the step across tab switches;
// the humanizer's switch and minimum are the server's global settings and save at once.
export function AdvancedSettings({
  open,
  onClose,
  stepLabel,
  idPrefix,
  instruction,
  onInstruction,
  running,
  body,
  humanizer,
}: AdvancedSettingsProps) {
  const toneValue: ToneChoice = instruction.tone === null ? 'auto' : (String(instruction.tone) as ToneChoice)
  return (
    <Modal
      open={open}
      size="md"
      title="Paramètres avancés"
      onClose={onClose}
      footer={
        <Button variant="primary" onClick={onClose}>
          OK
        </Button>
      }
    >
      <div className="mail-advanced">
        <TextAreaField
          id={`${idPrefix}-field`}
          label="Consignes supplémentaires"
          info={`Ex. : plus court, insister sur la logistique. ${formatCount(INSTRUCTION_MAX_LENGTH)} caractères au plus ; l’IA n’invente aucun fait. S’applique à la prochaine rédaction du message ${stepLabel}.`}
          value={instruction.text}
          maxLength={INSTRUCTION_MAX_LENGTH}
          rows={3}
          readOnly={running}
          onChange={(event) => {
            onInstruction({ ...instruction, text: event.target.value })
          }}
        />

        <div className="mail-advanced__row">
          <div className="mail-advanced__label">
            <span id={`${idPrefix}-tone`}>Ton</span>
            <InfoTip label="Aide : Ton">
              0 : {TONE_MEANINGS.low}. 5 : {TONE_MEANINGS.high}. Auto : selon la proximité avec le contact.
            </InfoTip>
          </div>
          <div className="mail-advanced__control mail-advanced__control--fill">
            <Segmented
              label="Ton"
              value={toneValue}
              options={TONE_OPTIONS}
              disabled={running}
              onChange={(choice) => {
                onInstruction({ ...instruction, tone: choice === 'auto' ? null : (Number(choice) as AiTone) })
              }}
            />
            <p className="mail-advanced__ends" aria-hidden="true">
              <span>Strictement pro</span>
              <span>Amical</span>
            </p>
          </div>
        </div>

        <div className="mail-advanced__row">
          <div className="mail-advanced__label">
            <span>Expéditeur</span>
            <InfoTip label="Aide : Expéditeur">
              En tant qu’IA : {SENDER_EXAMPLES.ai.example} En tant que personne : {SENDER_EXAMPLES.person.example}
            </InfoTip>
          </div>
          <div className="mail-advanced__control">
            <Segmented
              label="Expéditeur"
              value={instruction.sender ?? 'auto'}
              options={SENDER_OPTIONS}
              disabled={running}
              onChange={(choice) => {
                onInstruction({ ...instruction, sender: choice === 'auto' ? null : choice })
              }}
            />
          </div>
        </div>

        <HumanizerSettings body={body} humanizer={humanizer} />
      </div>
    </Modal>
  )
}

function HumanizerSettings({ body, humanizer }: { body: string; humanizer: HumanizerDefaults | undefined }) {
  const integrations = useIntegrations()
  const { save } = useIntegrationsMutations()
  const check = useHumanizerCheck()
  const enabled = humanizer?.enabled ?? false
  const minScore = humanizer?.min_score ?? 70
  // The slider's value while it is dragged; null = the saved one.
  const [dragged, setDragged] = useState<number | null>(null)
  const draft = dragged ?? minScore
  const [failure, setFailure] = useState<string | null>(null)
  const version = integrations.data?.version
  const unavailable = version === undefined

  async function apply(changes: { humanizer_enabled?: boolean; humanizer_min_score?: number }) {
    if (version === undefined) return
    setFailure(null)
    try {
      await save.mutateAsync({ version, changes })
    } catch {
      setFailure('Réglage non enregistré : réessayez (ou voyez Config AI › Humanizer).')
    } finally {
      setDragged(null)
    }
  }

  const result: HumanizerCheck | undefined = check.data
  return (
    <section className="mail-advanced__humanizer" aria-label="Humanizer">
      <div className="mail-advanced__label">
        <ShieldCheckIcon size={18} />
        <span>Humanizer</span>
        <InfoTip label="Aide : Humanizer">
          Contrôle HumanGPT : le message doit atteindre ce score « humain » (0 à 100) pour être validé. Réglage global du serveur.
          {humanizer && !humanizer.configured ? ' Aucune clé HumanGPT n’est enregistrée.' : ''}
        </InfoTip>
        {humanizer && !humanizer.configured && (
          <Link className="mail-advanced__link" to="/config-ai/humanizer">
            Ajouter la clé
          </Link>
        )}
      </div>
      <Switch
        label="Contrôler le score avant l’envoi"
        checked={enabled}
        disabled={unavailable || save.isPending}
        onChange={(event) => {
          void apply({ humanizer_enabled: event.target.checked })
        }}
      />
      <div className="mail-advanced__score">
        <label htmlFor="mail-humanizer-min">Score minimal</label>
        <input
          id="mail-humanizer-min"
          type="range"
          min={0}
          max={100}
          step={1}
          value={draft}
          disabled={unavailable || save.isPending}
          onChange={(event) => {
            setDragged(Number(event.target.value))
          }}
          onPointerUp={() => {
            if (dragged !== null && dragged !== minScore) void apply({ humanizer_min_score: dragged })
          }}
          onKeyUp={() => {
            if (dragged !== null && dragged !== minScore) void apply({ humanizer_min_score: dragged })
          }}
          onBlur={() => {
            if (dragged !== null && dragged !== minScore) void apply({ humanizer_min_score: dragged })
          }}
        />
        <span className="mail-advanced__value" aria-hidden="true">
          {draft}
        </span>
      </div>
      <div className="mail-advanced__check">
        <Button
          size="sm"
          icon={ShieldCheckIcon}
          loading={check.isPending}
          disabled={body.trim() === '' || (humanizer !== undefined && !humanizer.configured)}
          title={body.trim() === '' ? 'Rien à vérifier : le message est vide.' : 'Calcule le score « humain » du texte affiché'}
          onClick={() => {
            check.mutate(body)
          }}
        >
          Vérifier maintenant
        </Button>
        {result && (
          <p className={`mail-advanced__result mail-advanced__result--${result.passed ? 'ok' : 'low'}`} role="status">
            {result.passed ? <CheckCircleIcon size={16} /> : <AlertIcon size={16} />}
            <strong>{result.human_score}</strong>/100
            <span>{result.passed ? 'suffisant' : `sous le minimum (${String(result.min_score)})`}</span>
          </p>
        )}
        {check.isError && (
          <p className="mail-advanced__result mail-advanced__result--low" role="alert">
            <AlertIcon size={16} />
            {checkFailure(check.error)}
          </p>
        )}
        {failure && (
          <p className="mail-advanced__result mail-advanced__result--low" role="alert">
            <AlertIcon size={16} />
            {failure}
          </p>
        )}
      </div>
    </section>
  )
}
