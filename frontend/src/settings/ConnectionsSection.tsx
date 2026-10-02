import { useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router'

import { type Integrations, useIntegrations } from '../api/integrations'
import { type ToolboxCallback, type ToolboxStatus, useToolboxMutations, useToolboxStatus, useToolboxTools } from '../api/toolbox'
import { formatDateTime } from '../contact/labels'
import { leaveFor } from '../lib/browser'
import { useElapsed } from '../lib/useElapsed'
import { Button } from '../ui/Button'
import { Modal } from '../ui/Dialog'
import { AlertIcon, ArrowLeftIcon, LinkIcon, LogOutIcon, RefreshIcon, SpinnerIcon, TerminalIcon } from '../ui/icons'
import { DispatchCard, IntegrationCard, OpenAICard, SenderCard, ToolboxAdvanced } from './IntegrationCards'
import { type Feedback, FeedbackBanner } from './shared'
import { LIMITATIONS, STATE_BADGES, stateSentence, toolboxErrorLabel, toolboxFailure } from './toolboxCopy'

// The OAuth return parameters this page consumes (and then removes from the address bar).
const CALLBACK_KEYS = ['code', 'state', 'iss', 'error', 'error_description'] as const
// A return already posted: React's development double effect must not post it twice (the state is single-use).
const handledReturns = new Set<string>()

// Paramètres › Connexions: everything VIPER needs from outside, typed here (Contact port S8 — no server file to edit).
// Cards: Rédaction IA (OpenAI), Expéditeur, CIRCOE Toolbox (S6: « Se connecter à CIRCOE Toolbox », « Se
// déconnecter… », the last failure, the limitations, advanced addresses) and Envoi programmé (S7). It is also the page
// the Toolbox sends the browser back to: the return's query is posted to the API once, then removed from the URL.
export function ConnectionsSection() {
  const status = useToolboxStatus()
  const integrations = useIntegrations()
  const mutations = useToolboxMutations()
  const [feedback, setFeedback] = useState<Feedback | null>(null)
  const [forgetting, setForgetting] = useState(false)
  const [params, setParams] = useSearchParams()
  // The return being finalized (token exchange on the server), with its live counter.
  const returning = mutations.callback.isPending ? mutations.callback.submittedAt : null
  const returningFor = useElapsed(returning)
  const [redirecting, setRedirecting] = useState<number | null>(null)
  const redirectingFor = useElapsed(redirecting)
  const backRef = useRef<HTMLButtonElement>(null)

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

  async function connect() {
    setFeedback(null)
    setRedirecting(Date.now())
    try {
      const { authorization_url } = await mutations.connect.mutateAsync()
      // The Toolbox (then Infomaniak) takes over; it sends the browser back to this page.
      leaveFor(authorization_url)
    } catch (error) {
      setRedirecting(null)
      setFeedback({ tone: 'error', text: `Connexion à la Toolbox impossible : ${toolboxFailure(error)}.` })
    }
  }

  async function forget() {
    setFeedback(null)
    try {
      await mutations.forget.mutateAsync()
      setFeedback({
        tone: 'success',
        text: 'Déconnecté de CIRCOE Toolbox : plus aucun brouillon n’est créé dans Infomaniak et l’envoi programmé est arrêté.',
      })
    } catch (error) {
      setFeedback({ tone: 'error', text: `Impossible de se déconnecter : ${toolboxFailure(error)}.` })
    } finally {
      setForgetting(false)
    }
  }

  return (
    <>
      <header className="settings-panel__header">
        <div>
          <h2 className="settings-panel__title">Connexions</h2>
          <p className="settings-panel__description">
            Services externes utilisés par VIPER, réglés ici et appliqués aussitôt. Clés et accès sont conservés sur le
            serveur, hors de la base de données, et ne sont jamais renvoyés au navigateur. Toute personne connectée à
            VIPER peut les remplacer.
          </p>
        </div>
      </header>

      <FeedbackBanner feedback={feedback} />

      {returning !== null && (
        <p className="settings-state" role="status">
          <SpinnerIcon size={18} className="settings-connection__spinner" />
          Finalisation de la connexion à la Toolbox… {String(returningFor)} s
        </p>
      )}

      {(status.isPending || integrations.isPending) && <p className="settings-state">Chargement…</p>}
      {(status.isError || integrations.isError) && (
        <div className="settings-state settings-state--error" role="alert">
          <AlertIcon size={18} />
          {integrations.isError ? 'Réglages des connexions indisponibles.' : 'État de la connexion indisponible.'}
          <Button
            size="sm"
            onClick={() => {
              void status.refetch()
              void integrations.refetch()
            }}
          >
            Réessayer
          </Button>
        </div>
      )}
      {integrations.data?.load_error && (
        <p className="settings-connection__error" role="alert">
          <AlertIcon size={16} />
          Les réglages enregistrés ici n’ont pas pu être relus au démarrage du serveur (
          {integrations.data.load_error === 'unreadable' ? 'fichier illisible' : 'contenu refusé'}) : les valeurs par
          défaut s’appliquent
          {integrations.data.load_dropped.length > 0
            ? ` pour : ${integrations.data.load_dropped.map((name) => SETTING_LABELS[name] ?? name).join(', ')}`
            : ''}
          . Enregistrez-les à nouveau.
        </p>
      )}
      {integrations.data && (
        <div className="settings-connections">
          <OpenAICard data={integrations.data} />
          <SenderCard data={integrations.data} />
          {status.data && (
            <ToolboxCard
              status={status.data}
              integrations={integrations.data}
              redirecting={redirecting !== null}
              redirectingFor={redirectingFor}
              busy={returning !== null}
              onConnect={() => void connect()}
              onForget={() => {
                setForgetting(true)
              }}
              onRefresh={() => status.refetch()}
            />
          )}
          <DispatchCard data={integrations.data} status={status.data} />
          <StorageNote data={integrations.data} />
        </div>
      )}

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
    </>
  )
}

// The names of the settings, as the page shows them (for the « dropped at startup » warning).
const SETTING_LABELS: Record<string, string> = {
  openai_api_key: 'clé d’API OpenAI',
  openai_model: 'modèle',
  openai_base_url: 'adresse de l’API',
  openai_timeout_ms: 'délai d’attente',
  openai_max_retries: 'nouvelles tentatives',
  contact_booking_url: 'lien de prise de rendez-vous',
  default_outbound_email: 'adresse « De » par défaut',
  toolbox_mail_enabled: 'activation de la Toolbox',
  toolbox_mcp_url: 'adresse du serveur CIRCOE Toolbox',
  toolbox_oauth_redirect_uri: 'adresse de retour',
  contact_dispatch_enabled: 'envoi automatique des mails programmés',
  contact_dispatch_interval_ms: 'délai maximal avant envoi',
  infomaniak_send_allowlist: 'adresses autorisées',
}

// Where the settings live and who changed them last.
function StorageNote({ data }: { data: Integrations }) {
  const last = data.updated_at
    ? ` Dernière modification le ${formatDateTime(data.updated_at)}${data.updated_by ? ` par ${data.updated_by}` : ''}.`
    : ''
  return (
    <p className="settings-connection__note">
      Réglages conservés sur le serveur dans <span className="settings-connection__mono">{data.storage_path}</span>.{last}
    </p>
  )
}

interface ToolboxCardProps {
  status: ToolboxStatus
  integrations: Integrations
  redirecting: boolean
  redirectingFor: number
  busy: boolean
  onConnect: () => void
  onForget: () => void
  onRefresh: () => Promise<unknown>
}

// The back of the card: the MCP methods the Toolbox allows this connection, in a scrollable list.
function ToolboxMethods({ tools }: { tools: ReturnType<typeof useToolboxTools> }) {
  if (tools.isPending) {
    return (
      <p className="settings-state" role="status">
        <SpinnerIcon size={18} className="settings-connection__spinner" />
        Lecture des méthodes de la Toolbox…
      </p>
    )
  }
  if (tools.isError) {
    return (
      <p className="settings-connection__error" role="alert">
        <AlertIcon size={16} />
        Méthodes indisponibles : {toolboxFailure(tools.error)}.
      </p>
    )
  }
  return (
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
  )
}

function ToolboxCard({ status, integrations, redirecting, redirectingFor, busy, onConnect, onForget, onRefresh }: ToolboxCardProps) {
  const linked = status.state === 'connected' || status.state === 'expired'
  const [flipped, setFlipped] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const showMethods = flipped && linked
  const tools = useToolboxTools(showMethods)
  const { refetch: refetchTools } = tools

  // « Actualiser »: reads the state again and, when the methods are shown, asks the Toolbox for them again (they may
  // have changed on its side). A refused token is marked by the server: the state read afterwards shows it.
  async function refresh() {
    setRefreshing(true)
    try {
      if (showMethods) await refetchTools()
      await onRefresh()
    } finally {
      setRefreshing(false)
    }
  }

  return (
    <IntegrationCard
      id="settings-connection-toolbox"
      icon={LinkIcon}
      title="CIRCOE Toolbox"
      subtitle="Brouillons Infomaniak des messages Contact validés, et leur envoi programmé"
      badge={STATE_BADGES[status.state]}
    >

      <p className="settings-connection__sentence">{stateSentence(status)}</p>

      {showMethods && <ToolboxMethods tools={tools} />}

      {!showMethods && linked && (
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
          {status.toolbox_origin && (
            <div>
              <dt>Serveur</dt>
              <dd className="settings-connection__mono">{status.toolbox_origin}</dd>
            </div>
          )}
        </dl>
      )}

      {!showMethods && status.last_error && (
        <p className="settings-connection__error" role="note">
          <AlertIcon size={16} />
          Dernier échec ({formatDateTime(status.last_error.at)}) : {toolboxErrorLabel(status.last_error.code)}.
        </p>
      )}

      {!showMethods && status.cleanups.pending > 0 && (
        <p className="settings-connection__note">
          {status.cleanups.pending === 1
            ? '1 brouillon obsolète en attente de suppression dans Infomaniak'
            : `${String(status.cleanups.pending)} brouillons obsolètes en attente de suppression dans Infomaniak`}
          {status.cleanups.failing > 0 ? ` (dont ${String(status.cleanups.failing)} en échec, nouvel essai automatique)` : ''}
          .
        </p>
      )}

      {!showMethods && (
        <>
          <ul className="settings-connection__limits">
            {LIMITATIONS.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>

          <ToolboxAdvanced data={integrations} open={status.state === 'not_configured'} linked={linked} />
        </>
      )}

      <div className="settings-connection__actions">
        {linked && (
          <Button
            variant="ghost"
            icon={showMethods ? ArrowLeftIcon : TerminalIcon}
            aria-pressed={showMethods}
            onClick={() => {
              setFlipped(!showMethods)
            }}
          >
            {showMethods ? 'Retour à la connexion' : 'Méthodes autorisées'}
          </Button>
        )}
        <Button variant="ghost" icon={RefreshIcon} loading={refreshing} disabled={busy || redirecting} onClick={() => void refresh()}>
          Actualiser
        </Button>
        {linked && (
          <Button variant="ghost" icon={LogOutIcon} disabled={busy || redirecting} onClick={onForget}>
            Se déconnecter…
          </Button>
        )}
        <Button
          variant={status.state === 'connected' ? 'secondary' : 'primary'}
          icon={linked ? RefreshIcon : LinkIcon}
          loading={redirecting}
          disabled={busy}
          onClick={onConnect}
        >
          {redirecting
            ? `Ouverture de la Toolbox… ${String(redirectingFor)} s`
            : linked
              ? 'Reconnecter'
              : 'Se connecter à CIRCOE Toolbox'}
        </Button>
      </div>
    </IntegrationCard>
  )
}
