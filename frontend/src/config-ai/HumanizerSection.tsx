import { useState } from 'react'

import { type Integrations, type IntegrationsChanges, useIntegrations, useIntegrationsMutations } from '../api/integrations'
import { Button } from '../ui/Button'
import { FieldFrame, Switch, TextField } from '../ui/fields'
import { AlertIcon, ExternalLinkIcon, KeyIcon, ShieldCheckIcon, TrashIcon } from '../ui/icons'
import { InfoTip } from '../ui/InfoTip'
import { IntegrationCard, ResetHint, SaveButton, settingInfo, useCardForm, useCardSave } from '../settings/IntegrationCards'
import '../settings/connections.css'
import { sourceText } from '../settings/integrationsModel'
import { type Feedback, FeedbackBanner } from '../settings/shared'

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

// Config AI › Humanizer: the HumanGPT token (write-only, like the other secrets), the switch that turns the quality
// check on or off, and the « human score » a mail must reach before it can be validated.
export function HumanizerSection() {
  const integrations = useIntegrations()
  return (
    <>
      <header className="settings-panel__header">
        <h2 className="settings-panel__title">Humanizer</h2>
      </header>
      {integrations.isPending && <p className="settings-state">Chargement…</p>}
      {integrations.isError && (
        <div className="settings-state settings-state--error" role="alert">
          <AlertIcon size={18} />
          Réglages Humanizer indisponibles.
          <Button
            size="sm"
            onClick={() => {
              void integrations.refetch()
            }}
          >
            Réessayer
          </Button>
        </div>
      )}
      {integrations.data && (
        <div className="settings-connections">
          <HumanizerCard data={integrations.data} />
        </div>
      )}
    </>
  )
}

const FIELDS = ['humanizer_min_score'] as const

export function HumanizerCard({ data }: { data: Integrations }) {
  const { save, checkHumanizer } = useIntegrationsMutations()
  const form = useCardForm(data)
  const card = useCardSave(data, form)
  const token = data.humanizer_api_key
  const enabled = data.fields.humanizer_enabled.value === true
  const [draft, setDraft] = useState('')
  const [replacing, setReplacing] = useState(false)
  const [feedback, setFeedback] = useState<Feedback | null>(null)
  const [checked, setChecked] = useState<boolean | null>(null)

  const pending = form.changes(FIELDS)
  const keyTyped = draft.trim() !== ''
  const dirty = keyTyped || Object.keys(pending.changes).length > 0 || Object.keys(pending.invalid).length > 0
  const busy = card.saving || checkHumanizer.isPending

  async function submitKey(next: string | null, success: string) {
    setFeedback(null)
    const done = await card.submit({ humanizer_api_key: next }, success, [])
    if (done.ok) {
      setDraft('')
      setReplacing(false)
      setChecked(null)
      save.reset()
    }
  }

  async function saveAll() {
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
      setChecked(null)
      if (keyTyped) save.reset()
    }
  }

  async function test() {
    setFeedback(null)
    try {
      const result = await checkHumanizer.mutateAsync()
      setChecked(result.ok)
      if (!result.ok) setFeedback({ tone: 'error', text: failureText(result.code) })
    } catch {
      setChecked(null)
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
  const badge = !token.set
    ? ({ tone: 'neutral', label: 'Non configuré' } as const)
    : checked === false
      ? ({ tone: 'danger', label: 'Clé refusée' } as const)
      : !enabled
        ? ({ tone: 'neutral', label: 'Désactivé' } as const)
        : ({ tone: 'success', label: 'Actif' } as const)

  return (
    <IntegrationCard
      id="settings-connection-humanizer"
      icon={ShieldCheckIcon}
      title="Humanizer (HumanGPT)"
      subtitle="Avant qu’un mail soit validé, HumanGPT donne un score « humain » de 0 à 100 : en dessous du minimum choisi, la validation est refusée et le texte est à retoucher. Désactivable à tout moment."
      badge={badge}
    >
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
            info={
              <>
                Jamais réaffichée ni transmise au navigateur : seule sa fin est rappelée. {source} Créez-la sur{' '}
                {HUMANGPT_TOKEN_URL}.
              </>
            }
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
            <a className="btn btn--ghost btn--sm" href={HUMANGPT_TOKEN_URL} target="_blank" rel="noreferrer">
              <ExternalLinkIcon size={16} />
              Créer la clé
            </a>
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
            {token.set && token.source === 'ui' && !replacing && (
              <Button
                size="sm"
                variant="ghost"
                icon={TrashIcon}
                disabled={busy}
                onClick={() => void submitKey(null, 'Clé HumanGPT effacée.')}
              >
                Effacer
              </Button>
            )}
            <InfoTip label="Aide : créer la clé">
              Sur humangpt.io, ouvrez Compte › API (humangpt.io/account#api), créez un jeton puis collez-le ici.
            </InfoTip>
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
      <div className="settings-connection__actions">
        <Button loading={checkHumanizer.isPending} disabled={busy || !token.set} onClick={() => void test()}>
          Tester
        </Button>
        <SaveButton saving={card.saving} elapsed={card.elapsed} disabled={!dirty} onClick={() => void saveAll()}>
          Enregistrer
        </SaveButton>
      </div>
    </IntegrationCard>
  )
}
