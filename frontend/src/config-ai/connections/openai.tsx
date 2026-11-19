import { type ReactNode, useRef, useState } from 'react'

import {
  type Integrations,
  type IntegrationsChanges,
  type KeyCheck,
  useIntegrationsMutations,
  useOpenAIModels,
} from '../../api/integrations'
import { ResetHint, SaveButton, settingInfo, useCardForm, useCardSave } from '../../settings/IntegrationCards'
import {
  checkFailure,
  checkText,
  type FormField,
  KEY_REQUIRED_WITH_BASE_URL,
  modelsFailure,
  sourceText,
} from '../../settings/integrationsModel'
import { type Feedback, FeedbackBanner } from '../../settings/shared'
import { useElapsed } from '../../lib/useElapsed'
import { Button, IconButton } from '../../ui/Button'
import { Modal } from '../../ui/Dialog'
import { FieldFrame, SelectField, TextField } from '../../ui/fields'
import { AlertIcon, KeyIcon, PlayIcon, TrashIcon } from '../../ui/icons'
import { OpenAILogo } from '../logos'
import { type Connection, Pane, PaneActions } from './connection'

// OpenAI: the drafting key and model (« Générer avec l’IA »), and the technical options of the API.

const OPENAI_FIELDS = ['openai_model', 'openai_base_url', 'openai_timeout_ms', 'openai_max_retries'] as const

export function useOpenAIConnection(data: Integrations): Connection {
  const { checkKey } = useIntegrationsMutations()
  const model = data.fields.openai_model.value
  const key = data.openai_api_key
  return {
    id: 'openai',
    title: 'OpenAI',
    Logo: OpenAILogo,
    summary: typeof model === 'string' && model !== '' ? `${model}${key.last4 ? ` · clé …${key.last4}` : ''}` : 'Modèle non choisi',
    about:
      'Propositions de mails dans Contact (« Générer avec l’IA »), toujours enregistrées en brouillon à relire et à valider. Renseignez une clé d’API OpenAI et le modèle à utiliser.',
    badge: data.generation_available ? { tone: 'success', label: 'Configurée' } : { tone: 'neutral', label: 'Non configurée' },
    quickTest: {
      label: 'Tester la clé OpenAI',
      pending: checkKey.isPending,
      disabled: !data.generation_available,
      disabledReason: 'Enregistrez d’abord une clé et un modèle',
      run: async () => {
        try {
          const result = await checkKey.mutateAsync()
          return { tone: result.ok ? 'success' : 'danger', label: result.ok ? 'Clé valide' : 'Clé refusée', detail: checkText(result) }
        } catch (error) {
          return { tone: 'warning', label: 'Test impossible', detail: checkFailure(error) }
        }
      },
    },
    tabs: [
      { id: 'connection', label: 'Connexion' },
      { id: 'advanced', label: 'Avancé' },
    ],
    body: <OpenAIBody data={data} />,
  }
}

interface ModelFieldProps {
  data: Integrations
  value: string
  error?: string
  fieldProps: (help: ReactNode) => { info: ReactNode; hint: ReactNode }
  busy: boolean
  onChange: (value: string) => void
  // The free-text field, when the service gives no list (no key yet, unreachable, refused key).
  text: (extraInfo?: string) => ReactNode
}

// « Modèle »: the models the saved key can use, read live from the service (newest first). A value the list does not
// hold (typed before, or removed by OpenAI) stays selectable, marked as such, so nothing changes behind the person.
function ModelField({ data, value, error, fieldProps, busy, onChange, text }: ModelFieldProps) {
  const models = useOpenAIModels(data.openai_api_key.set)
  if (!data.openai_api_key.set || models.isError || (models.data && models.data.models.length === 0)) {
    const failure = models.isError
      ? 'Liste des modèles indisponible : le serveur VIPER n’a pas répondu.'
      : models.data?.code && models.data.code !== 'ai_not_configured'
        ? modelsFailure(models.data.code)
        : null
    return (
      <>
        {text(data.openai_api_key.set ? undefined : modelsFailure('ai_not_configured'))}
        {failure && (
          <p className="field__warning" role="status">
            <AlertIcon size={16} />
            {failure}
          </p>
        )}
      </>
    )
  }
  const list = models.data?.models ?? []
  const unlisted = value !== '' && !list.includes(value)
  return (
    <SelectField
      label="Modèle"
      value={value}
      error={error}
      disabled={busy || models.isPending}
      {...fieldProps(
        models.isPending
          ? 'Chargement des modèles de votre compte OpenAI…'
          : 'Modèles disponibles avec votre clé, du plus récent au plus ancien. La liste suit votre compte OpenAI.',
      )}
      onChange={(event) => {
        onChange(event.target.value)
      }}
    >
      <option value="">Choisir un modèle…</option>
      {unlisted && <option value={value}>{value} (absent de la liste)</option>}
      {list.map((model) => (
        <option key={model} value={model}>
          {model}
        </option>
      ))}
    </SelectField>
  )
}

interface KeyFieldProps {
  data: Integrations
  draft: string
  replacing: boolean
  error?: string
  warning?: string
  busy: boolean
  onDraft: (value: string) => void
  onReplace: () => void
  onCancel: () => void
}

// The OpenAI key, write-only: the server never sends it back. Saved: a masked placeholder with its last four
// characters and « Remplacer ».
function KeyField({ data, draft, replacing, error, warning, busy, onDraft, onReplace, onCancel }: KeyFieldProps) {
  const key = data.openai_api_key
  const inputRef = useRef<HTMLInputElement>(null)
  const editable = !key.set || replacing
  const placeholder = key.set ? `•••• ${key.last4 ?? ''} (enregistrée)` : 'sk-…'
  const source =
    key.source === 'ui'
      ? sourceText({ source: 'ui', updated_at: key.updated_at, updated_by: key.updated_by })
      : key.source === 'env'
        ? 'Clé fournie par la configuration du serveur.'
        : 'Aucune clé enregistrée.'
  return (
    <div className="settings-secret">
      <FieldFrame
        label="Clé d’API OpenAI"
        error={error}
        warning={warning}
        info={`Jamais réaffichée ni transmise au navigateur : seule sa fin est rappelée. ${source}`}
      >
        {(a11y) => (
          <input
            {...a11y}
            ref={inputRef}
            type="password"
            className="field__control"
            autoComplete="new-password"
            spellCheck={false}
            placeholder={placeholder}
            disabled={!editable || busy}
            value={editable ? draft : ''}
            onChange={(event) => {
              onDraft(event.target.value)
            }}
          />
        )}
      </FieldFrame>
      {key.set && (
        <div className="settings-secret__actions">
          {replacing ? (
            <Button size="sm" disabled={busy} onClick={onCancel}>
              Annuler
            </Button>
          ) : (
            <Button
              size="sm"
              icon={KeyIcon}
              disabled={busy}
              onClick={() => {
                onReplace()
                window.setTimeout(() => inputRef.current?.focus(), 0)
              }}
            >
              Remplacer
            </Button>
          )}
        </div>
      )}
    </div>
  )
}

function OpenAIBody({ data }: { data: Integrations }) {
  const form = useCardForm(data)
  const card = useCardSave(data, form)
  const { checkKey } = useIntegrationsMutations()
  const [keyDraft, setKeyDraft] = useState('')
  const [replacing, setReplacing] = useState(false)
  const [clearing, setClearing] = useState(false)
  const [check, setCheck] = useState<Feedback | null>(null)
  const [checkStartedAt, setCheckStartedAt] = useState<number | null>(null)
  const checkElapsed = useElapsed(checkStartedAt)
  const backRef = useRef<HTMLButtonElement>(null)

  const pending = form.changes(OPENAI_FIELDS)
  const keyTyped = keyDraft.trim() !== ''
  const dirty = keyTyped || Object.keys(pending.changes).length > 0 || Object.keys(pending.invalid).length > 0
  const busy = card.saving

  async function save() {
    if (Object.keys(pending.invalid).length > 0) {
      form.setErrors(pending.invalid)
      return
    }
    const changes: IntegrationsChanges = { ...pending.changes }
    // « Remplacer » left empty keeps the saved key.
    if (keyTyped) changes.openai_api_key = keyDraft.trim()
    const saved = await card.submit(
      changes,
      keyTyped ? 'Clé et réglages OpenAI enregistrés : ils s’appliquent dès maintenant.' : 'Réglages OpenAI enregistrés : ils s’appliquent dès maintenant.',
      OPENAI_FIELDS,
    )
    if (saved.ok) {
      setKeyDraft('')
      setReplacing(false)
      setCheck(null)
      if (keyTyped) card.clearMutation()
    } else if (saved.field === 'openai_api_key' && data.openai_api_key.set) {
      // The key must be typed again (e.g. a new API address): open the field for it.
      setReplacing(true)
    }
  }

  async function clearKey() {
    const done = await card.submit({ openai_api_key: null }, 'Clé OpenAI effacée.', [])
    if (done.ok) setCheck(null)
    setClearing(false)
  }

  async function test() {
    setCheck(null)
    setCheckStartedAt(Date.now())
    try {
      const result: KeyCheck = await checkKey.mutateAsync()
      setCheck({ tone: result.ok ? 'success' : 'error', text: checkText(result) })
    } catch (error) {
      setCheck({ tone: 'error', text: checkFailure(error) })
    } finally {
      setCheckStartedAt(null)
    }
  }

  const fieldProps = (field: FormField, help?: ReactNode) => ({
    info: settingInfo(data, field, help),
    hint: (
      <ResetHint
        data={data}
        field={field}
        busy={busy}
        onReset={(name) => void card.submit({ [name]: null }, 'Valeur par défaut rétablie.', [name])}
      />
    ),
  })
  const text = (field: FormField, label: string, help: ReactNode, props: { type?: string; inputMode?: 'numeric' | 'decimal' } = {}) => (
    <TextField
      label={label}
      value={form.value(field)}
      error={form.errors[field]}
      {...fieldProps(field, help)}
      disabled={busy}
      spellCheck={false}
      {...props}
      onChange={(event) => {
        form.edit(field, event.target.value)
      }}
    />
  )

  const status = (
    <>
      {(check || checkStartedAt !== null) && (
        <div role="status">
          {checkStartedAt !== null ? (
            <p className="settings-state">Test de la clé auprès du service… {String(checkElapsed)} s</p>
          ) : (
            check && <FeedbackBanner feedback={check} />
          )}
        </div>
      )}
      <FeedbackBanner feedback={card.feedback} />
    </>
  )
  const key = data.openai_api_key
  const testDisabled = busy || !data.generation_available || dirty
  const actions = (
    <PaneActions
      secondary={
        <>
          <IconButton
            icon={PlayIcon}
            label="Tester la clé"
            loading={checkStartedAt !== null}
            disabled={testDisabled}
            title={dirty ? 'Enregistrez d’abord vos modifications' : !data.generation_available ? 'Enregistrez d’abord une clé et un modèle' : 'Tester la clé'}
            onClick={() => void test()}
          />
          {key.set && key.source === 'ui' && (
            <IconButton
              icon={TrashIcon}
              label="Effacer…"
              title="Effacer la clé enregistrée ici"
              disabled={busy}
              onClick={() => {
                setClearing(true)
              }}
            />
          )}
        </>
      }
    >
      <SaveButton saving={busy} elapsed={card.elapsed} disabled={!dirty} onClick={() => void save()}>
        Enregistrer
      </SaveButton>
    </PaneActions>
  )

  return (
    <>
      <Pane id="connection">
        <div className="settings-form">
          <KeyField
            data={data}
            draft={keyDraft}
            replacing={replacing}
            error={form.errors.openai_api_key}
            warning={
              'openai_base_url' in pending.changes && key.set && !keyTyped ? KEY_REQUIRED_WITH_BASE_URL : undefined
            }
            busy={busy}
            onDraft={(value) => {
              setKeyDraft(value)
              form.setErrors({ ...form.errors, openai_api_key: undefined })
            }}
            onReplace={() => {
              setReplacing(true)
            }}
            onCancel={() => {
              setReplacing(false)
              setKeyDraft('')
            }}
          />
          <ModelField
            data={data}
            value={form.value('openai_model')}
            error={form.errors.openai_model}
            fieldProps={(help) => fieldProps('openai_model', help)}
            busy={busy}
            onChange={(value) => {
              form.edit('openai_model', value)
            }}
            text={(extra) => text('openai_model', 'Modèle', extra ?? 'Identifiant exact du modèle choisi dans votre compte OpenAI ; VIPER n’en impose aucun.')}
          />
        </div>
        {actions}
      </Pane>
      <Pane id="advanced">
        <div className="settings-form">
          {text('openai_base_url', 'Adresse de l’API', 'À changer seulement pour passer par un service compatible.', { type: 'url' })}
          {text('openai_timeout_ms', 'Délai d’attente (secondes)', 'Par étape réseau, entre 1 et 300.', { inputMode: 'decimal' })}
          {text('openai_max_retries', 'Nouvelles tentatives', 'Après une erreur passagère, de 0 à 5.', { inputMode: 'numeric' })}
        </div>
        {actions}
      </Pane>
      {status}

      <Modal
        open={clearing}
        size="sm"
        title="Effacer la clé OpenAI ?"
        initialFocusRef={backRef}
        onClose={() => {
          setClearing(false)
        }}
        footer={
          <>
            <Button
              ref={backRef}
              disabled={busy}
              onClick={() => {
                setClearing(false)
              }}
            >
              Retour
            </Button>
            <Button variant="danger" icon={TrashIcon} loading={busy} onClick={() => void clearKey()}>
              Effacer la clé
            </Button>
          </>
        }
      >
        <div className="settings-dialog">
          <p>
            La clé enregistrée ici est supprimée du serveur. « Générer avec l’IA » s’arrête aussitôt, sauf si le serveur
            fournit sa propre clé.
          </p>
          <p>Les brouillons déjà rédigés par l’IA ne changent pas.</p>
        </div>
      </Modal>
    </>
  )
}
