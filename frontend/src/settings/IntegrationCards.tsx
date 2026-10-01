import { type ReactNode, type SyntheticEvent, useRef, useState } from 'react'

import {
  type Integrations,
  type IntegrationsChanges,
  type KeyCheck,
  useIntegrationsMutations,
} from '../api/integrations'
import { connectionReturnAddress, type ToolboxStatus } from '../api/toolbox'
import { formatDateTime } from '../contact/labels'
import { useElapsed } from '../lib/useElapsed'
import { StatusBadge, type StatusTone } from '../ui/Badge'
import { Button } from '../ui/Button'
import { Modal } from '../ui/Dialog'
import { FieldFrame, SelectField, TextAreaField, TextField } from '../ui/fields'
import {
  ChevronDownIcon,
  ClockIcon,
  type IconComponent,
  KeyIcon,
  MailIcon,
  SaveIcon,
  SparklesIcon,
  TrashIcon,
  UndoIcon,
} from '../ui/icons'
import {
  checkFailure,
  checkText,
  fallbackText,
  type FormField,
  fromDraft,
  intervalOptions,
  KEY_REQUIRED_WITH_BASE_URL,
  saveRefusal,
  sourceText,
  toDraft,
} from './integrationsModel'
import { type Feedback, FeedbackBanner } from './shared'
import { dispatchBadge, dispatchSentence } from './toolboxCopy'

// Paramètres › Connexions (Contact port S8): the integration settings typed in the browser — OpenAI, the default
// sender, the scheduled sending, and the Toolbox's advanced addresses. Each card saves its own fields (one primary
// button); every field says where its value comes from and can go back to the default.

interface CardShellProps {
  id: string
  icon: IconComponent
  title: string
  subtitle: string
  badge?: { tone: StatusTone; label: string }
  children: ReactNode
}

export function IntegrationCard({ id, icon: Icon, title, subtitle, badge, children }: CardShellProps) {
  return (
    <section className="settings-connection" aria-labelledby={id}>
      <header className="settings-connection__header">
        <span className="settings-connection__icon" aria-hidden="true">
          <Icon size={20} />
        </span>
        <div className="settings-connection__heading">
          <h3 id={id} className="settings-connection__title">
            {title}
          </h3>
          <p className="settings-connection__subtitle">{subtitle}</p>
        </div>
        {badge && <StatusBadge tone={badge.tone}>{badge.label}</StatusBadge>}
      </header>
      {children}
    </section>
  )
}

// The edited fields of one card (only what the person changed: untouched fields follow the server).
function useCardForm(data: Integrations) {
  const [edits, setEdits] = useState<Partial<Record<FormField, string>>>({})
  const [errors, setErrors] = useState<Partial<Record<string, string>>>({})
  const value = (field: FormField) => edits[field] ?? toDraft(field, data.fields[field].value)
  return {
    value,
    errors,
    setErrors,
    edit(field: FormField, next: string) {
      setEdits((current) => ({ ...current, [field]: next }))
      setErrors((current) => ({ ...current, [field]: undefined }))
    },
    forget(fields: readonly FormField[]) {
      setEdits((current) =>
        Object.fromEntries(Object.entries(current).filter(([field]) => !(fields as readonly string[]).includes(field))),
      )
    },
    // The changed fields of `fields`, or the local errors (a number that is not one).
    changes(fields: readonly FormField[]): { changes: IntegrationsChanges; invalid: Partial<Record<string, string>> } {
      const changes: IntegrationsChanges = {}
      const invalid: Partial<Record<string, string>> = {}
      for (const field of fields) {
        const draft = edits[field]
        if (draft === undefined || draft === toDraft(field, data.fields[field].value)) continue
        const parsed = fromDraft(field, draft)
        if (parsed instanceof Error) invalid[field] = parsed.message
        else changes[field] = parsed
      }
      return { changes, invalid }
    },
  }
}

type CardForm = ReturnType<typeof useCardForm>

// Saves one card's changes; says the outcome in the card and puts a refused value's message under its field.
function useCardSave(data: Integrations, form: CardForm) {
  const { save } = useIntegrationsMutations()
  const [feedback, setFeedback] = useState<Feedback | null>(null)
  const [startedAt, setStartedAt] = useState<number | null>(null)
  const elapsed = useElapsed(startedAt)

  // Answers the refused field (if any) on failure, null on success.
  async function submit(
    changes: IntegrationsChanges,
    success: string,
    clear: readonly FormField[],
  ): Promise<{ ok: boolean; field?: string }> {
    setFeedback(null)
    setStartedAt(Date.now())
    try {
      await save.mutateAsync({ version: data.version, changes })
      form.forget(clear)
      form.setErrors({})
      setFeedback({ tone: 'success', text: success })
      return { ok: true }
    } catch (error) {
      const refusal = saveRefusal(error)
      if (refusal.field) form.setErrors({ [refusal.field]: refusal.message })
      setFeedback({ tone: 'error', text: refusal.field ? 'Rien n’a été enregistré : corrigez le champ signalé.' : refusal.message })
      return { ok: false, field: refusal.field }
    } finally {
      setStartedAt(null)
    }
  }

  // `clearMutation`: forget the last request's variables (a typed key must not stay in memory, S8 QA m3).
  return { submit, feedback, saving: startedAt !== null, elapsed, clearMutation: save.reset }
}

interface HintProps {
  data: Integrations
  field: FormField
  help?: ReactNode
  busy: boolean
  onReset: (field: FormField) => void
}

// Under a field: what it is for, where its value comes from, and « Rétablir » for a value set here.
function SettingHint({ data, field, help, busy, onReset }: HintProps) {
  const setting = data.fields[field]
  return (
    <>
      {help && <span className="settings-setting__help">{help}</span>}
      <span className="settings-setting__source">
        {sourceText(setting)}
        {setting.source === 'ui' && (
          <>
            {' '}
            <button
              type="button"
              className="settings-setting__reset"
              disabled={busy}
              title={`Rétablir la valeur par défaut : ${fallbackText(field, setting.fallback)}`}
              onClick={() => {
                onReset(field)
              }}
            >
              <UndoIcon size={14} />
              Rétablir
            </button>
          </>
        )}
      </span>
    </>
  )
}

function SaveButton({ saving, elapsed, disabled, variant = 'primary', children, onClick }: {
  saving: boolean
  elapsed: number
  disabled: boolean
  variant?: 'primary' | 'secondary'
  children: ReactNode
  onClick: () => void
}) {
  return (
    <Button variant={variant} icon={SaveIcon} loading={saving} disabled={disabled} onClick={onClick}>
      {saving ? `Enregistrement… ${String(elapsed)} s` : children}
    </Button>
  )
}

// A disclosure the page may open (a missing setting) but never closes under the person: after a save that settles
// the missing setting, the section stays open so its outcome stays visible.
function useDisclosure(openWhen: boolean) {
  const [open, setOpen] = useState(openWhen)
  const [asked, setAsked] = useState(openWhen)
  // Adjusted during render (no effect): opens when the page newly asks for it, never closes by itself.
  if (openWhen !== asked) {
    setAsked(openWhen)
    if (openWhen) setOpen(true)
  }
  return {
    open,
    onToggle: (event: SyntheticEvent<HTMLDetailsElement>) => {
      setOpen(event.currentTarget.open)
    },
  }
}

// A collapsed group of rarely changed settings (native disclosure: keyboard and screen readers for free).
function Advanced({ children, open = false }: { children: ReactNode; open?: boolean }) {
  const disclosure = useDisclosure(open)
  return (
    <details className="settings-advanced" {...disclosure}>
      <summary className="settings-advanced__summary">
        <ChevronDownIcon size={16} className="settings-advanced__chevron" />
        Paramètres avancés
      </summary>
      <div className="settings-form">{children}</div>
    </details>
  )
}

// --- OpenAI -------------------------------------------------------------------------------------------------------

const OPENAI_FIELDS = ['openai_model', 'contact_booking_url', 'openai_base_url', 'openai_timeout_ms', 'openai_max_retries'] as const

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
  onClear: () => void
}

// The OpenAI key, write-only: the server never sends it back. Saved: a masked placeholder with its last four
// characters, « Remplacer » and « Effacer… » (a key set here only).
function KeyField({ data, draft, replacing, error, warning, busy, onDraft, onReplace, onCancel, onClear }: KeyFieldProps) {
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
        hint={
          <>
            <span className="settings-setting__help">
              Jamais réaffichée ni transmise au navigateur : seule sa fin est rappelée.
            </span>
            <span className="settings-setting__source">{source}</span>
          </>
        }
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
          {key.source === 'ui' && !replacing && (
            <Button size="sm" variant="ghost" icon={TrashIcon} disabled={busy} onClick={onClear}>
              Effacer…
            </Button>
          )}
        </div>
      )}
    </div>
  )
}

export function OpenAICard({ data }: { data: Integrations }) {
  const form = useCardForm(data)
  const card = useCardSave(data, form)
  const { checkKey } = useIntegrationsMutations()
  const [keyDraft, setKeyDraft] = useState('')
  const [replacing, setReplacing] = useState(false)
  const [clearing, setClearing] = useState(false)
  const [check, setCheck] = useState<{ tone: 'success' | 'error'; text: string } | null>(null)
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

  async function reset(field: FormField) {
    await card.submit({ [field]: null }, 'Valeur par défaut rétablie.', [field])
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

  const hint = (field: FormField, help?: ReactNode) => (
    <SettingHint data={data} field={field} help={help} busy={busy} onReset={(name) => void reset(name)} />
  )
  const text = (field: FormField, label: string, help: ReactNode, props: { type?: string; inputMode?: 'numeric' | 'decimal' } = {}) => (
    <TextField
      label={label}
      value={form.value(field)}
      error={form.errors[field]}
      hint={hint(field, help)}
      disabled={busy}
      spellCheck={false}
      {...props}
      onChange={(event) => {
        form.edit(field, event.target.value)
      }}
    />
  )

  return (
    <IntegrationCard
      id="settings-connection-openai"
      icon={SparklesIcon}
      title="Rédaction IA (OpenAI)"
      subtitle="Propositions de mails dans Contact, toujours enregistrées en Brouillon"
      badge={data.generation_available ? { tone: 'success', label: 'Configurée' } : { tone: 'neutral', label: 'Non configurée' }}
    >
      <p className="settings-connection__sentence">
        {data.generation_available
          ? '« Générer avec l’IA » est disponible dans Contact. Chaque proposition reste un brouillon à relire et à valider.'
          : 'Saisissez une clé d’API OpenAI et le modèle à utiliser pour activer « Générer avec l’IA » dans Contact.'}
      </p>
      <div className="settings-form">
        <KeyField
          data={data}
          draft={keyDraft}
          replacing={replacing}
          error={form.errors.openai_api_key}
          warning={
            'openai_base_url' in pending.changes && data.openai_api_key.set && !keyTyped ? KEY_REQUIRED_WITH_BASE_URL : undefined
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
          onClear={() => {
            setClearing(true)
          }}
        />
        {text('openai_model', 'Modèle', 'Identifiant exact du modèle choisi dans votre compte OpenAI ; VIPER n’en impose aucun.')}
        {text('contact_booking_url', 'Lien de prise de rendez-vous', 'Recopié tel quel par l’IA dans le mail. Vide : aucun lien proposé.', { type: 'url' })}
        <Advanced>
          {text('openai_base_url', 'Adresse de l’API', 'À changer seulement pour passer par un service compatible.', { type: 'url' })}
          {text('openai_timeout_ms', 'Délai d’attente (secondes)', 'Par étape réseau, entre 1 et 300.', { inputMode: 'decimal' })}
          {text('openai_max_retries', 'Nouvelles tentatives', 'Après une erreur passagère, de 0 à 5.', { inputMode: 'numeric' })}
        </Advanced>
      </div>

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

      <div className="settings-connection__actions">
        <Button
          icon={KeyIcon}
          loading={checkStartedAt !== null}
          disabled={busy || !data.generation_available || dirty}
          title={dirty ? 'Enregistrez d’abord vos modifications' : !data.generation_available ? 'Enregistrez d’abord une clé et un modèle' : undefined}
          onClick={() => void test()}
        >
          {checkStartedAt !== null ? `Test en cours… ${String(checkElapsed)} s` : 'Tester la clé'}
        </Button>
        <SaveButton saving={busy} elapsed={card.elapsed} disabled={!dirty} onClick={() => void save()}>
          Enregistrer
        </SaveButton>
      </div>

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
    </IntegrationCard>
  )
}

// --- Expéditeur ---------------------------------------------------------------------------------------------------

export function SenderCard({ data }: { data: Integrations }) {
  const form = useCardForm(data)
  const card = useCardSave(data, form)
  const fields = ['default_outbound_email'] as const
  const pending = form.changes(fields)
  const dirty = Object.keys(pending.changes).length > 0
  return (
    <IntegrationCard
      id="settings-connection-sender"
      icon={MailIcon}
      title="Expéditeur"
      subtitle="Adresse « De » préremplie dans les nouveaux messages Contact"
    >
      <div className="settings-form">
        <TextField
          label="Adresse « De » par défaut"
          type="email"
          value={form.value('default_outbound_email')}
          error={form.errors.default_outbound_email}
          disabled={card.saving}
          hint={
            <SettingHint
              data={data}
              field="default_outbound_email"
              busy={card.saving}
              help="Indicative : avec CIRCOE Toolbox, le mail part de la boîte Infomaniak par défaut du compte connecté."
              onReset={(field) => void card.submit({ [field]: null }, 'Valeur par défaut rétablie.', [field])}
            />
          }
          onChange={(event) => {
            form.edit('default_outbound_email', event.target.value)
          }}
        />
      </div>
      <FeedbackBanner feedback={card.feedback} />
      <div className="settings-connection__actions">
        <SaveButton
          saving={card.saving}
          elapsed={card.elapsed}
          disabled={!dirty}
          onClick={() => void card.submit(pending.changes, 'Expéditeur enregistré : il s’applique aux prochains messages.', fields)}
        >
          Enregistrer
        </SaveButton>
      </div>
    </IntegrationCard>
  )
}

// --- Envoi programmé ----------------------------------------------------------------------------------------------

const DISPATCH_FIELDS = ['contact_dispatch_interval_ms', 'infomaniak_send_allowlist'] as const

export function DispatchCard({ data, status }: { data: Integrations; status: ToolboxStatus | undefined }) {
  const form = useCardForm(data)
  const card = useCardSave(data, form)
  const pending = form.changes(DISPATCH_FIELDS)
  const dirty = Object.keys(pending.changes).length > 0
  const savedInterval = Number(data.fields.contact_dispatch_interval_ms.value ?? 0)
  const interval = Number(form.value('contact_dispatch_interval_ms'))
  const badge = status ? dispatchBadge(status, savedInterval) : undefined
  const reset = (field: FormField) => void card.submit({ [field]: null }, 'Valeur par défaut rétablie.', [field])
  return (
    <IntegrationCard
      id="settings-connection-dispatch"
      icon={ClockIcon}
      title="Envoi programmé"
      subtitle="Départ automatique des messages programmés dans Contact, par CIRCOE Toolbox"
      badge={badge}
    >
      {status && <p className="settings-connection__sentence">{dispatchSentence(status, savedInterval)}</p>}
      {status && (
        <dl className="settings-connection__facts">
          <div>
            <dt>Dernière passe</dt>
            <dd>
              {status.dispatch.last_pass_at
                ? `${formatDateTime(status.dispatch.last_pass_at)}${status.dispatch.last_outcome === 'error' ? ' (en échec : voir les journaux du serveur)' : ''}`
                : 'aucune depuis le démarrage'}
            </dd>
          </div>
          <div>
            <dt>Messages programmés</dt>
            <dd>{String(status.dispatch.scheduled)}</dd>
          </div>
          {status.dispatch.unconfirmed > 0 && (
            <div>
              <dt>Envois non confirmés</dt>
              <dd>{String(status.dispatch.unconfirmed)} à trancher dans Contact</dd>
            </div>
          )}
        </dl>
      )}
      <div className="settings-form">
        <SelectField
          label="Fréquence de vérification"
          value={String(interval)}
          error={form.errors.contact_dispatch_interval_ms}
          disabled={card.saving}
          hint={
            <SettingHint
              data={data}
              field="contact_dispatch_interval_ms"
              busy={card.saving}
              help="Désactivé par défaut : activez-le après avoir vérifié un premier envoi."
              onReset={reset}
            />
          }
          onChange={(event) => {
            form.edit('contact_dispatch_interval_ms', event.target.value)
          }}
        >
          {intervalOptions(interval).map((option) => (
            <option key={option.value} value={String(option.value)}>
              {option.label}
            </option>
          ))}
        </SelectField>
        <TextAreaField
          label="Adresses autorisées (facultatif)"
          rows={2}
          spellCheck={false}
          value={form.value('infomaniak_send_allowlist')}
          error={form.errors.infomaniak_send_allowlist}
          disabled={card.saving}
          placeholder="prenom.nom@circoe.fr, @circoe.fr"
          hint={
            <SettingHint
              data={data}
              field="infomaniak_send_allowlist"
              busy={card.saving}
              help="Adresses ou règles « @domaine » séparées par des virgules : un message vers une autre adresse ne part pas. Vide : aucune restriction."
              onReset={reset}
            />
          }
          onChange={(event) => {
            form.edit('infomaniak_send_allowlist', event.target.value)
          }}
        />
      </div>
      <p className="settings-connection__note">
        Un message programmé ne part que si le serveur VIPER est en marche ; trop en retard, il revient à « Validé » sans
        partir.
      </p>
      <FeedbackBanner feedback={card.feedback} />
      <div className="settings-connection__actions">
        <SaveButton
          saving={card.saving}
          elapsed={card.elapsed}
          disabled={!dirty}
          onClick={() => void card.submit(pending.changes, 'Envoi programmé enregistré : il s’applique dès maintenant.', DISPATCH_FIELDS)}
        >
          Enregistrer
        </SaveButton>
      </div>
    </IntegrationCard>
  )
}

// --- CIRCOE Toolbox: the advanced addresses -----------------------------------------------------------------------

const TOOLBOX_FIELDS = ['toolbox_mcp_url', 'toolbox_oauth_redirect_uri'] as const

// Inside the Toolbox card, collapsed: the server address (built in) and the return address (this page's, sent when
// connecting). Its save button is secondary: « Se connecter à CIRCOE Toolbox » stays the card's primary action.
export function ToolboxAdvanced({ data, open, linked }: { data: Integrations; open: boolean; linked: boolean }) {
  const form = useCardForm(data)
  const card = useCardSave(data, form)
  const pending = form.changes(TOOLBOX_FIELDS)
  const dirty = Object.keys(pending.changes).length > 0
  // A save that changes the server address while connected waits for a confirmation (S8 QA B1).
  const [confirming, setConfirming] = useState<{ changes: IntegrationsChanges; success: string; clear: readonly FormField[] } | null>(null)
  const backRef = useRef<HTMLButtonElement>(null)
  function submit(changes: IntegrationsChanges, success: string, clear: readonly FormField[]) {
    if (linked && 'toolbox_mcp_url' in changes) {
      setConfirming({ changes, success, clear })
      return
    }
    void card.submit(changes, success, clear)
  }
  const reset = (field: FormField) => {
    submit({ [field]: null }, 'Valeur par défaut rétablie.', [field])
  }
  const disclosure = useDisclosure(open)
  const field = (name: (typeof TOOLBOX_FIELDS)[number], label: string, help: ReactNode, placeholder?: string) => (
    <TextField
      label={label}
      type="url"
      spellCheck={false}
      value={form.value(name)}
      placeholder={placeholder}
      error={form.errors[name]}
      disabled={card.saving}
      hint={<SettingHint data={data} field={name} help={help} busy={card.saving} onReset={reset} />}
      onChange={(event) => {
        form.edit(name, event.target.value)
      }}
    />
  )
  return (
    <details className="settings-advanced" {...disclosure}>
      <summary className="settings-advanced__summary">
        <ChevronDownIcon size={16} className="settings-advanced__chevron" />
        Paramètres avancés
      </summary>
      <div className="settings-form">
        {field('toolbox_mcp_url', 'Adresse du serveur CIRCOE Toolbox', 'Adresse MCP de la Toolbox (https).')}
        {field(
          'toolbox_oauth_redirect_uri',
          'Adresse de retour',
          `Vide : l’adresse de cette page est envoyée à la connexion (${connectionReturnAddress()}).`,
          connectionReturnAddress(),
        )}
        <FeedbackBanner feedback={card.feedback} />
        <div className="settings-connection__actions">
          <SaveButton
            variant="secondary"
            saving={card.saving}
            elapsed={card.elapsed}
            disabled={!dirty}
            onClick={() => {
              submit(pending.changes, 'Paramètres de la Toolbox enregistrés.', TOOLBOX_FIELDS)
            }}
          >
            Enregistrer les paramètres avancés
          </SaveButton>
        </div>
      </div>
      <Modal
        open={confirming !== null}
        size="sm"
        title="Changer l’adresse du serveur ?"
        initialFocusRef={backRef}
        onClose={() => {
          setConfirming(null)
        }}
        footer={
          <>
            <Button
              ref={backRef}
              onClick={() => {
                setConfirming(null)
              }}
            >
              Retour
            </Button>
            <Button
              variant="danger"
              icon={SaveIcon}
              onClick={() => {
                const pendingSave = confirming
                setConfirming(null)
                if (pendingSave) void card.submit(pendingSave.changes, pendingSave.success, pendingSave.clear)
              }}
            >
              Changer et déconnecter
            </Button>
          </>
        }
      >
        <div className="settings-dialog">
          <p>
            Changer l’adresse du serveur déconnecte la Toolbox : l’accès actuel a été délivré pour l’ancienne adresse et
            n’est jamais envoyé à une autre. Les brouillons et l’envoi programmé s’arrêtent jusqu’à une nouvelle
            connexion.
          </p>
        </div>
      </Modal>
    </details>
  )
}

