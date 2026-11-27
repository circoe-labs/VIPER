import { useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router'

import type { Integrations, IntegrationsChanges } from '../../api/integrations'
import {
  connectionReturnAddress,
  type ToolboxCallback,
  type ToolboxStatus,
  useToolboxMutations,
  useToolboxStatus,
  useToolboxTools,
} from '../../api/toolbox'
import { formatDateTime } from '../../contact/labels'
import { leaveFor } from '../../lib/browser'
import { useElapsed } from '../../lib/useElapsed'
import { ResetHint, SaveButton, settingInfo, useCardForm, useCardSave } from '../../settings/IntegrationCards'
import {
  DEFAULT_DISPATCH_INTERVAL_MS,
  DISPATCH_DELAY_MAX_MS,
  DISPATCH_DELAY_MIN_MS,
  FIELD_ERRORS,
  type FormField,
} from '../../settings/integrationsModel'
import { type Feedback, FeedbackBanner } from '../../settings/shared'
import { ToolboxDiagnosticCard } from '../../settings/ToolboxDiagnosticCard'
import {
  dispatchBacklog,
  dispatchBadge,
  dispatchOn,
  dispatchSentence,
  LIMITATIONS,
  STATE_BADGES,
  stateSentence,
  toolboxErrorLabel,
  toolboxFailure,
} from '../../settings/toolboxCopy'
import { StatusBadge } from '../../ui/Badge'
import { Button, IconButton } from '../../ui/Button'
import { Modal } from '../../ui/Dialog'
import { Switch, TextAreaField, TextField } from '../../ui/fields'
import { AlertIcon, LinkIcon, LogOutIcon, RefreshIcon, SaveIcon, SpinnerIcon } from '../../ui/icons'
import { InfoTip } from '../../ui/InfoTip'
import { ToolboxLogo } from '../logos'
import { type Connection, OPEN_PARAM, Pane, PaneActions, usePaneActive } from './connection'

// CIRCOE Toolbox: the Infomaniak mailbox link (OAuth), the scheduled sending, the allowed methods, the diagnostic and
// the advanced addresses — ONE connection, five tabs.

// The OAuth return parameters this page consumes (and then removes from the address bar).
const CALLBACK_KEYS = ['code', 'state', 'iss', 'error', 'error_description'] as const
// A return already posted: React's development double effect must not post it twice (the state is single-use).
const handledReturns = new Set<string>()

export interface ToolboxFlow {
  feedback: Feedback | null
  returning: boolean
  returningFor: number
  redirecting: boolean
  redirectingFor: number
  connect: () => void
  forget: () => Promise<void>
}

// The Toolbox is also the page the browser comes back to after Infomaniak: the return's query is posted to the API once,
// then removed from the URL, and `?open=toolbox` opens the connection's dialog to show the outcome.
export function useToolboxFlow(): ToolboxFlow {
  const mutations = useToolboxMutations()
  const [feedback, setFeedback] = useState<Feedback | null>(null)
  const [params, setParams] = useSearchParams()
  const returning = mutations.callback.isPending ? mutations.callback.submittedAt : null
  const returningFor = useElapsed(returning)
  const [redirecting, setRedirecting] = useState<number | null>(null)
  const redirectingFor = useElapsed(redirecting)

  // A return without `state` is still posted: the server refuses it (`toolbox_state_invalid`) and records it.
  const hasReturn = params.has('code') || params.has('error')
  const returnKey = `${params.get('state') ?? ''}|${params.get('code') ?? ''}|${params.get('error') ?? ''}`
  const { mutateAsync: postCallback } = mutations.callback
  useEffect(() => {
    if (!hasReturn || handledReturns.has(returnKey)) return
    handledReturns.add(returnKey)
    const payload: ToolboxCallback = {
      state: params.get('state') ?? '',
      code: params.get('code') ?? '',
      iss: params.get('iss') ?? '',
      error: params.get('error') ?? '',
    }
    setParams(
      (current) => {
        const next = new URLSearchParams(current)
        for (const key of CALLBACK_KEYS) next.delete(key)
        next.set(OPEN_PARAM, 'toolbox')
        return next
      },
      { replace: true },
    )
    postCallback(payload)
      .then((connected) => {
        setFeedback({
          tone: 'success',
          text: connected.expires_at
            ? `CIRCOE Toolbox connectée jusqu’au ${formatDateTime(connected.expires_at)}.`
            : 'CIRCOE Toolbox connectée.',
        })
      })
      .catch((error: unknown) => {
        setFeedback({ tone: 'error', text: `Connexion à la Toolbox impossible : ${toolboxFailure(error)}.` })
      })
  }, [hasReturn, returnKey, params, setParams, postCallback])

  return {
    feedback,
    returning: returning !== null,
    returningFor,
    redirecting: redirecting !== null,
    redirectingFor,
    connect() {
      setFeedback(null)
      setRedirecting(Date.now())
      mutations.connect
        .mutateAsync()
        .then(({ authorization_url }) => {
          // The Toolbox (then Infomaniak) takes over; it sends the browser back to this page.
          leaveFor(authorization_url)
        })
        .catch((error: unknown) => {
          setRedirecting(null)
          setFeedback({ tone: 'error', text: `Connexion à la Toolbox impossible : ${toolboxFailure(error)}.` })
        })
    },
    async forget() {
      setFeedback(null)
      try {
        await mutations.forget.mutateAsync()
        setFeedback({
          tone: 'success',
          text: 'Déconnecté de CIRCOE Toolbox : plus aucun brouillon n’est créé dans Infomaniak et l’envoi programmé est arrêté.',
        })
      } catch (error) {
        setFeedback({ tone: 'error', text: `Impossible de se déconnecter : ${toolboxFailure(error)}.` })
      }
    },
  }
}

export function useToolboxConnection(data: Integrations, status: ToolboxStatus | undefined, flow: ToolboxFlow): Connection {
  const refetch = useToolboxStatus().refetch
  const [testing, setTesting] = useState(false)
  const linked = status?.state === 'connected' || status?.state === 'expired'
  const badge = status ? STATE_BADGES[status.state] : { tone: 'neutral' as const, label: 'Chargement…' }
  return {
    id: 'toolbox',
    title: 'CIRCOE Toolbox',
    Logo: ToolboxLogo,
    summary: linked ? `Infomaniak · ${status.connected_by ?? 'compte connecté'}` : 'Boîte Infomaniak et envoi programmé',
    about:
      'Brouillons Infomaniak des messages Contact validés, et leur envoi programmé, par CIRCOE Toolbox. Une seule connexion pour tout VIPER.',
    badge,
    quickTest: {
      label: 'Actualiser l’état de la Toolbox',
      pending: testing,
      disabled: !status,
      run: async () => {
        setTesting(true)
        try {
          const result = await refetch()
          const next = result.data
          if (!next) return { tone: 'warning', label: 'Test impossible' }
          const shown = STATE_BADGES[next.state]
          return { ...shown, detail: next.last_error ? `Dernier échec : ${toolboxErrorLabel(next.last_error.code)}.` : undefined }
        } finally {
          setTesting(false)
        }
      },
    },
    tabs: [
      { id: 'connection', label: 'Connexion' },
      { id: 'dispatch', label: 'Envoi programmé' },
      ...(linked ? [{ id: 'methods', label: 'Méthodes' }] : []),
      { id: 'diagnostic', label: 'Diagnostic' },
      { id: 'advanced', label: 'Avancé' },
    ],
    initialTab: status?.state === 'not_configured' ? 'advanced' : undefined,
    body: status ? <ToolboxBody data={data} status={status} flow={flow} /> : null,
  }
}

function ToolboxBody({ data, status, flow }: { data: Integrations; status: ToolboxStatus; flow: ToolboxFlow }) {
  const linked = status.state === 'connected' || status.state === 'expired'
  return (
    <>
      <ConnectionPane status={status} flow={flow} linked={linked} />
      <DispatchPane data={data} status={status} />
      {linked && <MethodsPane />}
      <Pane id="diagnostic">
        <ToolboxDiagnosticCard />
      </Pane>
      <AdvancedPane data={data} linked={linked} />
    </>
  )
}

function ConnectionPane({ status, flow, linked }: { status: ToolboxStatus; flow: ToolboxFlow; linked: boolean }) {
  const toolboxStatus = useToolboxStatus()
  const [refreshing, setRefreshing] = useState(false)
  const [forgetting, setForgetting] = useState(false)
  // Said before disconnecting: what is scheduled will be held back.
  const scheduledCount = status.dispatch.scheduled + (status.dispatch.warehouse_scheduled ?? 0)
  const mutations = useToolboxMutations()
  const backRef = useRef<HTMLButtonElement>(null)
  const busy = flow.returning || flow.redirecting

  async function refresh() {
    setRefreshing(true)
    try {
      await toolboxStatus.refetch()
    } finally {
      setRefreshing(false)
    }
  }

  async function forget() {
    await flow.forget()
    setForgetting(false)
  }

  return (
    <Pane id="connection">
      {flow.returning && (
        <p className="settings-state" role="status">
          <SpinnerIcon size={18} className="settings-connection__spinner" />
          Finalisation de la connexion à la Toolbox… {String(flow.returningFor)} s
        </p>
      )}
      <FeedbackBanner feedback={flow.feedback} />
      <div className="settings-connection__note">
        {stateSentence(status)}{' '}
        <InfoTip label="Aide : limites de la connexion">
          <ul className="settings-connection__limits">
            {LIMITATIONS.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </InfoTip>
      </div>
      {linked && (
        <dl className="settings-connection__facts">
          {status.connected_by && (
            <div>
              <dt>Connectée par</dt>
              <dd>{status.connected_by}</dd>
            </div>
          )}
          {status.connected_at && (
            <div>
              <dt>Depuis le</dt>
              <dd>{formatDateTime(status.connected_at)}</dd>
            </div>
          )}
          {status.expires_at && (
            <div>
              <dt>{status.state === 'expired' ? 'Fin d’accès' : 'Valable jusqu’au'}</dt>
              <dd>{formatDateTime(status.expires_at)}</dd>
            </div>
          )}
        </dl>
      )}
      {status.last_error && (
        <p className="settings-connection__error" role="note">
          <AlertIcon size={16} />
          Dernier échec ({formatDateTime(status.last_error.at)}) : {toolboxErrorLabel(status.last_error.code)}.
        </p>
      )}
      {status.cleanups.pending > 0 && (
        <p className="settings-connection__note">
          {status.cleanups.pending === 1
            ? '1 brouillon obsolète en attente de suppression dans Infomaniak'
            : `${String(status.cleanups.pending)} brouillons obsolètes en attente de suppression dans Infomaniak`}
          {status.cleanups.failing > 0 ? ` (dont ${String(status.cleanups.failing)} en échec, nouvel essai automatique)` : ''}
          .
        </p>
      )}
      <PaneActions
        secondary={
          <>
            <IconButton icon={RefreshIcon} label="Actualiser" loading={refreshing} disabled={busy} onClick={() => void refresh()} />
            {linked && (
              <IconButton
                icon={LogOutIcon}
                label="Se déconnecter…"
                disabled={busy}
                onClick={() => {
                  setForgetting(true)
                }}
              />
            )}
          </>
        }
      >
        <Button
          variant={status.state === 'connected' ? 'secondary' : 'primary'}
          icon={linked ? RefreshIcon : LinkIcon}
          loading={flow.redirecting}
          disabled={flow.returning}
          onClick={flow.connect}
        >
          {flow.redirecting
            ? `Ouverture de la Toolbox… ${String(flow.redirectingFor)} s`
            : linked
              ? 'Reconnecter'
              : 'Se connecter à CIRCOE Toolbox'}
        </Button>
      </PaneActions>

      <Modal
        open={forgetting}
        size="sm"
        title="Se déconnecter de CIRCOE Toolbox ?"
        initialFocusRef={backRef}
        onClose={() => {
          setForgetting(false)
        }}
        footer={
          <>
            <Button
              ref={backRef}
              disabled={mutations.forget.isPending}
              onClick={() => {
                setForgetting(false)
              }}
            >
              Retour
            </Button>
            <Button variant="danger" icon={LogOutIcon} loading={mutations.forget.isPending} onClick={() => void forget()}>
              Se déconnecter
            </Button>
          </>
        }
      >
        <div className="settings-dialog">
          {scheduledCount > 0 && (
            <p className="settings-connection__error" role="alert">
              <AlertIcon size={16} />
              {scheduledCount > 1 ? `${String(scheduledCount)} mails programmés ne partiront pas` : '1 mail programmé ne partira pas'} tant
              que la Toolbox n’est pas reconnectée. Reconnectez le même compte : sinon leurs brouillons seront introuvables.
            </p>
          )}
          <p>
            VIPER efface son accès à la Toolbox et désactive l’intégration. Les prochains messages validés ne créeront
            plus de brouillon dans Infomaniak, l’envoi programmé s’arrête, et les brouillons déjà créés restent dans la
            boîte.
          </p>
          <p>
            La Toolbox ne propose pas de révocation : l’accès effacé expire de lui-même à sa date de fin. Vous pourrez
            vous reconnecter à tout moment.
          </p>
        </div>
      </Modal>
    </Pane>
  )
}

// The MCP methods the Toolbox allows this connection, in a scrollable list (read only while the tab is shown).
function MethodsPane() {
  return (
    <Pane id="methods">
      <Methods />
    </Pane>
  )
}

function Methods() {
  const active = usePaneActive()
  const tools = useToolboxTools(active)
  const { refetch } = tools
  const [refreshing, setRefreshing] = useState(false)
  async function refresh() {
    setRefreshing(true)
    try {
      await refetch()
    } finally {
      setRefreshing(false)
    }
  }
  return (
    <>
      {tools.isPending && (
        <p className="settings-state" role="status">
          <SpinnerIcon size={18} className="settings-connection__spinner" />
          Lecture des méthodes de la Toolbox…
        </p>
      )}
      {tools.isError && (
        <p className="settings-connection__error" role="alert">
          <AlertIcon size={16} />
          Méthodes indisponibles : {toolboxFailure(tools.error)}.
        </p>
      )}
      {tools.data && (
        <>
          <p className="settings-connection__note">
            {tools.data.length === 1 ? '1 méthode autorisée' : `${String(tools.data.length)} méthodes autorisées`} pour cette
            connexion.
          </p>
          <ul className="settings-connection__methods" tabIndex={0} aria-label="Méthodes MCP autorisées">
            {tools.data.map((tool) => (
              <li key={tool.name}>
                <span className="settings-connection__mono">{tool.name}</span>
                {tool.title && <strong>{tool.title}</strong>}
                {tool.description && <span className="settings-connection__note">{tool.description}</span>}
              </li>
            ))}
          </ul>
        </>
      )}
      <PaneActions secondary={<IconButton icon={RefreshIcon} label="Relire les méthodes" loading={refreshing} onClick={() => void refresh()} />} />
    </>
  )
}

const DISPATCH_FIELDS = ['contact_dispatch_interval_ms', 'infomaniak_send_allowlist'] as const

// One switch, on by default; the period is the « Délai maximal avant envoi »; off = no worker on the server.
function DispatchPane({ data, status }: { data: Integrations; status: ToolboxStatus }) {
  const form = useCardForm(data)
  const card = useCardSave(data, form)
  const pending = form.changes(DISPATCH_FIELDS)
  const dirty = Object.keys(pending.changes).length > 0 || Object.keys(pending.invalid).length > 0
  const on = dispatchOn(data)
  const savedInterval = Number(data.fields.contact_dispatch_interval_ms.value ?? 0)
  const seconds = (savedInterval > 0 ? savedInterval : DEFAULT_DISPATCH_INTERVAL_MS) / 1000
  const backlog = dispatchBacklog(data)
  const reset = (field: FormField) => void card.submit({ [field]: null }, 'Valeur par défaut rétablie.', [field])
  const badge = dispatchBadge(data)

  function toggle(next: boolean) {
    const changes: IntegrationsChanges = { contact_dispatch_enabled: next }
    // Switched on with a delay of 0 (set by the server's configuration): back to a working delay.
    if (next && savedInterval <= 0) changes.contact_dispatch_interval_ms = DEFAULT_DISPATCH_INTERVAL_MS
    void card.submit(
      changes,
      next
        ? 'Envoi automatique activé : les mails programmés partiront à leur heure dès que CIRCOE Toolbox est connectée.'
        : 'Envoi automatique désactivé : aucun mail programmé ne partira tant qu’il n’est pas réactivé.',
      [],
    )
  }

  function save() {
    const interval = pending.changes.contact_dispatch_interval_ms
    const outOfRange = typeof interval === 'number' && (interval < DISPATCH_DELAY_MIN_MS || interval > DISPATCH_DELAY_MAX_MS)
    if (Object.keys(pending.invalid).length > 0 || outOfRange) {
      form.setErrors({
        ...pending.invalid,
        ...(outOfRange ? { contact_dispatch_interval_ms: FIELD_ERRORS.contact_dispatch_interval_ms } : {}),
      })
      return
    }
    void card.submit(pending.changes, 'Envoi programmé enregistré : il s’applique dès maintenant.', DISPATCH_FIELDS)
  }

  return (
    <Pane id="dispatch">
      <div>
        <StatusBadge tone={badge.tone}>{badge.label}</StatusBadge>{' '}
        <InfoTip label="Aide : Envoi programmé">
          Départ automatique des messages programmés dans Contact, par CIRCOE Toolbox, à l’heure choisie (à{' '}
          {seconds.toLocaleString('fr-FR')} secondes près). {dispatchSentence(data)} Un message programmé ne part que si le
          serveur VIPER est en marche ; trop en retard, il revient à « Validé » sans partir.
        </InfoTip>
      </div>
      {backlog && (
        <p className="settings-feedback settings-feedback--warning">
          <AlertIcon size={18} />
          {backlog}
        </p>
      )}
      <div className="settings-form">
        <Switch
          label="Envoi automatique des mails programmés"
          checked={on}
          disabled={card.saving}
          onChange={(event) => {
            toggle(event.target.checked)
          }}
        />
        <TextAreaField
          label="Adresses autorisées (facultatif)"
          rows={2}
          spellCheck={false}
          value={form.value('infomaniak_send_allowlist')}
          error={form.errors.infomaniak_send_allowlist}
          disabled={card.saving}
          placeholder="prenom.nom@circoe.fr, @circoe.fr"
          info={settingInfo(
            data,
            'infomaniak_send_allowlist',
            'Adresses ou règles « @domaine » séparées par des virgules : un message vers une autre adresse ne part pas. Vide : aucune restriction.',
          )}
          hint={<ResetHint data={data} field="infomaniak_send_allowlist" busy={card.saving} onReset={reset} />}
          onChange={(event) => {
            form.edit('infomaniak_send_allowlist', event.target.value)
          }}
        />
        <TextField
          label="Délai maximal avant envoi (secondes)"
          inputMode="decimal"
          value={form.value('contact_dispatch_interval_ms')}
          error={form.errors.contact_dispatch_interval_ms}
          disabled={card.saving}
          info={settingInfo(
            data,
            'contact_dispatch_interval_ms',
            'VIPER regarde à ce rythme s’il y a des mails à envoyer : un mail part au plus tard ce délai après l’heure choisie. Entre 1 et 3 600 secondes.',
          )}
          hint={<ResetHint data={data} field="contact_dispatch_interval_ms" busy={card.saving} onReset={reset} />}
          onChange={(event) => {
            form.edit('contact_dispatch_interval_ms', event.target.value)
          }}
        />
      </div>
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
          <dd>{String(data.dispatch.scheduled_count)}</dd>
        </div>
        {status.dispatch.unconfirmed > 0 && (
          <div>
            <dt>Envois non confirmés</dt>
            <dd>{String(status.dispatch.unconfirmed)} à trancher dans Contact</dd>
          </div>
        )}
      </dl>
      <FeedbackBanner feedback={card.feedback} />
      <PaneActions>
        <SaveButton saving={card.saving} elapsed={card.elapsed} disabled={!dirty} onClick={save}>
          Enregistrer
        </SaveButton>
      </PaneActions>
    </Pane>
  )
}

const TOOLBOX_FIELDS = ['toolbox_mcp_url', 'toolbox_oauth_redirect_uri'] as const

// The server address (built in) and the return address (this page's, sent when connecting).
function AdvancedPane({ data, linked }: { data: Integrations; linked: boolean }) {
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
  const field = (name: (typeof TOOLBOX_FIELDS)[number], label: string, help: string, placeholder?: string) => (
    <TextField
      label={label}
      type="url"
      spellCheck={false}
      value={form.value(name)}
      placeholder={placeholder}
      error={form.errors[name]}
      disabled={card.saving}
      info={settingInfo(data, name, help)}
      hint={<ResetHint data={data} field={name} busy={card.saving} onReset={reset} />}
      onChange={(event) => {
        form.edit(name, event.target.value)
      }}
    />
  )
  return (
    <Pane id="advanced">
      <div className="settings-form">
        {field('toolbox_mcp_url', 'Adresse du serveur CIRCOE Toolbox', 'Adresse MCP de la Toolbox (https).')}
        {field(
          'toolbox_oauth_redirect_uri',
          'Adresse de retour',
          `Vide : l’adresse de cette page est envoyée à la connexion (${connectionReturnAddress()}).`,
          connectionReturnAddress(),
        )}
      </div>
      <FeedbackBanner feedback={card.feedback} />
      <PaneActions>
        <SaveButton
          saving={card.saving}
          elapsed={card.elapsed}
          disabled={!dirty}
          onClick={() => {
            submit(pending.changes, 'Paramètres de la Toolbox enregistrés.', TOOLBOX_FIELDS)
          }}
        >
          Enregistrer
        </SaveButton>
      </PaneActions>
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
    </Pane>
  )
}
