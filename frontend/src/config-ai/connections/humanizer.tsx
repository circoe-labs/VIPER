import { useState } from 'react'

import { type Integrations, type IntegrationsChanges, useIntegrationsMutations } from '../../api/integrations'
import { ResetHint, SaveButton, settingInfo, useCardForm, useCardSave } from '../../settings/IntegrationCards'
import { sourceText } from '../../settings/integrationsModel'
import { type Feedback, FeedbackBanner } from '../../settings/shared'
import { Button, IconButton } from '../../ui/Button'
import { FieldFrame, Switch, TextField } from '../../ui/fields'
import { ExternalLinkIcon, KeyIcon, PlayIcon, TrashIcon } from '../../ui/icons'
import { HumanGptLogo } from '../logos'
import { type Connection, Pane, PaneActions } from './connection'

export const HUMANGPT_TOKEN_URL = 'https://humangpt.io/account#api'

export const HUMANIZER_FAILURES: Record<string, string> = {
  humanizer_not_configured: 'Aucune clé enregistrée.',
  humanizer_auth_failed: 'HumanGPT refuse cette clé : elle est fausse, révoquée ou son compte n’a pas accès à l’API.',
  humanizer_rate_limited: 'HumanGPT limite temporairement les appels : réessayez dans quelques minutes.',
  humanizer_quota_exceeded: 'Le quota HumanGPT du compte est épuisé.',
  humanizer_timeout: 'HumanGPT n’a pas répondu à temps : réessayez dans un instant.',
  humanizer_upstream_error: 'HumanGPT ne répond pas : réessayez dans un instant.',
}

const failureText = (code: string | null) => HUMANIZER_FAILURES[code ?? ''] ?? 'HumanGPT n’a pas pu être joint.'

const FIELDS = ['humanizer_min_score'] as const

// HumanGPT (the « Humanizer »): the token, the switch that turns the quality check on or off, and the « human score »
// a mail must reach before it can be validated.
export function useHumanizerConnection(data: Integrations): Connection {
  const { checkHumanizer } = useIntegrationsMutations()
  const token = data.humanizer_api_key
  const enabled = data.fields.humanizer_enabled.value === true
  return {
    id: 'humangpt',
    title: 'HumanGPT',
    Logo: HumanGptLogo,
    summary: `Score humain minimal : ${String(data.fields.humanizer_min_score.value ?? '')}`,
    about:
      'Avant qu’un mail soit validé, HumanGPT donne un score « humain » de 0 à 100 : en dessous du minimum choisi, la validation est refusée et le texte est à retoucher. Désactivable à tout moment.',
    badge: !token.set ? { tone: 'neutral', label: 'Non configuré' } : !enabled ? { tone: 'neutral', label: 'Désactivé' } : { tone: 'success', label: 'Actif' },
    quickTest: {
      label: 'Tester la clé HumanGPT',
      pending: checkHumanizer.isPending,
      disabled: !token.set,
      disabledReason: 'Enregistrez d’abord une clé',
      run: async () => {
        try {
          const result = await checkHumanizer.mutateAsync()
          return result.ok
            ? { tone: 'success', label: 'Clé valide' }
            : { tone: 'danger', label: 'Clé refusée', detail: failureText(result.code) }
        } catch {
          return { tone: 'warning', label: 'Test impossible', detail: 'Le serveur VIPER n’a pas répondu, réessayez.' }
        }
      },
    },
    tabs: [{ id: 'connection', label: 'Connexion' }],
    body: <HumanizerBody data={data} />,
  }
}

function HumanizerBody({ data }: { data: Integrations }) {
  const { save, checkHumanizer } = useIntegrationsMutations()
  const form = useCardForm(data)
  const card = useCardSave(data, form)
  const token = data.humanizer_api_key
  const enabled = data.fields.humanizer_enabled.value === true
  const [draft, setDraft] = useState('')
  const [replacing, setReplacing] = useState(false)
  const [feedback, setFeedback] = useState<Feedback | null>(null)

  const pending = form.changes(FIELDS)
  const keyTyped = draft.trim() !== ''
  const dirty = keyTyped || Object.keys(pending.changes).length > 0 || Object.keys(pending.invalid).length > 0
  const busy = card.saving || checkHumanizer.isPending

  async function clearKey() {
    setFeedback(null)
    const done = await card.submit({ humanizer_api_key: null }, 'Clé HumanGPT effacée.', [])
    if (done.ok) {
      setDraft('')
      setReplacing(false)
      save.reset()
    }
  }

  async function saveAll() {
    setFeedback(null)
    if (Object.keys(pending.invalid).length > 0) {
      form.setErrors(pending.invalid)
      return
    }
    const changes: IntegrationsChanges = { ...pending.changes }
    if (keyTyped) changes.humanizer_api_key = draft.trim()
    const done = await card.submit(changes, keyTyped ? 'Clé et réglages Humanizer enregistrés.' : 'Réglages Humanizer enregistrés.', FIELDS)
    if (done.ok) {
      setDraft('')
      setReplacing(false)
      if (keyTyped) save.reset()
    }
  }

  async function test() {
    setFeedback(null)
    try {
      const result = await checkHumanizer.mutateAsync()
      setFeedback(result.ok ? { tone: 'success', text: 'Clé acceptée par HumanGPT.' } : { tone: 'error', text: failureText(result.code) })
    } catch {
      setFeedback({ tone: 'error', text: 'Le test n’a pas abouti : le serveur VIPER n’a pas répondu, réessayez.' })
    }
  }

  const source =
    token.source === 'ui'
      ? sourceText({ source: 'ui', updated_at: token.updated_at, updated_by: token.updated_by })
      : token.source === 'env'
        ? 'Clé fournie par la configuration du serveur.'
        : 'Aucune clé enregistrée.'
  const editable = !token.set || replacing

  return (
    <>
      <Pane id="connection">
        <div className="settings-form">
          <Switch
            label="Contrôler le score avant la validation"
            checked={enabled}
            disabled={busy}
            onChange={(event) => {
              void card.submit(
                { humanizer_enabled: event.target.checked },
                event.target.checked ? 'Humanizer activé : les mails doivent atteindre le score minimal.' : 'Humanizer désactivé : aucun contrôle de score.',
                [],
              )
            }}
          />
          <div className="settings-secret">
            <FieldFrame
              label="Clé d’API HumanGPT"
              info={`Jamais réaffichée ni transmise au navigateur : seule sa fin est rappelée. ${source} Créez-la sur humangpt.io › Compte › API.`}
            >
              {(a11y) => (
                <input
                  {...a11y}
                  type="password"
                  className="field__control"
                  autoComplete="new-password"
                  spellCheck={false}
                  placeholder={token.set ? `•••• ${token.last4 ?? ''} (enregistrée)` : 'Collez la clé'}
                  disabled={!editable || busy}
                  value={editable ? draft : ''}
                  onChange={(event) => {
                    setDraft(event.target.value)
                  }}
                />
              )}
            </FieldFrame>
            <div className="settings-secret__actions">
              {token.set && !replacing && (
                <Button
                  size="sm"
                  icon={KeyIcon}
                  disabled={busy}
                  onClick={() => {
                    setReplacing(true)
                  }}
                >
                  Remplacer
                </Button>
              )}
              {replacing && (
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() => {
                    setReplacing(false)
                    setDraft('')
                  }}
                >
                  Annuler
                </Button>
              )}
            </div>
          </div>
          <TextField
            label="Score minimal (0 à 100)"
            inputMode="numeric"
            value={form.value('humanizer_min_score')}
            error={form.errors.humanizer_min_score}
            disabled={busy}
            info={settingInfo(data, 'humanizer_min_score', 'Le score « humain » qu’un mail doit atteindre pour pouvoir être validé.')}
            hint={
              <ResetHint
                data={data}
                field="humanizer_min_score"
                busy={busy}
                onReset={(field) => void card.submit({ [field]: null }, 'Valeur par défaut rétablie.', [field])}
              />
            }
            onChange={(event) => {
              form.edit('humanizer_min_score', event.target.value)
            }}
          />
        </div>
        <FeedbackBanner feedback={feedback ?? card.feedback} />
        <PaneActions
          secondary={
            <>
              <IconButton icon={PlayIcon} label="Tester" loading={checkHumanizer.isPending} disabled={busy || !token.set} onClick={() => void test()} />
              <a className="btn btn--ghost btn--icon btn--md" href={HUMANGPT_TOKEN_URL} target="_blank" rel="noreferrer" aria-label="Créer la clé" title="Créer la clé sur humangpt.io">
                <ExternalLinkIcon size={20} />
              </a>
              {token.set && token.source === 'ui' && (
                <IconButton icon={TrashIcon} label="Effacer" title="Effacer la clé enregistrée ici" disabled={busy} onClick={() => void clearKey()} />
              )}
            </>
          }
        >
          <SaveButton saving={card.saving} elapsed={card.elapsed} disabled={!dirty} onClick={() => void saveAll()}>
            Enregistrer
          </SaveButton>
        </PaneActions>
      </Pane>
    </>
  )
}
