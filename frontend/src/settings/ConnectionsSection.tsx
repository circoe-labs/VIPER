import { useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router'

import { type ToolboxCallback, type ToolboxStatus, useToolboxMutations, useToolboxStatus } from '../api/toolbox'
import { formatDateTime } from '../contact/labels'
import { leaveFor } from '../lib/browser'
import { useElapsed } from '../lib/useElapsed'
import { StatusBadge } from '../ui/Badge'
import { Button } from '../ui/Button'
import { Modal } from '../ui/Dialog'
import { AlertIcon, LinkIcon, MailIcon, RefreshIcon, SpinnerIcon, TrashIcon } from '../ui/icons'
import { type Feedback, FeedbackBanner } from './shared'
import {
  dispatchBadge,
  dispatchSentence,
  LIMITATIONS,
  STATE_BADGES,
  stateSentence,
  toolboxErrorLabel,
  toolboxFailure,
} from './toolboxCopy'

// The OAuth return parameters this page consumes (and then removes from the address bar).
const CALLBACK_KEYS = ['code', 'state', 'iss', 'error', 'error_description'] as const
// A return already posted: React's development double effect must not post it twice (the state is single-use).
const handledReturns = new Set<string>()

// Paramètres › Connexions (Contact port S6): the CIRCOE Toolbox card — its state, « Connecter », « Oublier la
// connexion… », the last failure and the limitations. It is also the page the Toolbox sends the browser back to
// (`VIPER_TOOLBOX_OAUTH_REDIRECT_URI`): the return's query is posted to the API once, then removed from the URL.
export function ConnectionsSection() {
  const status = useToolboxStatus()
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
      setFeedback({ tone: 'success', text: 'Connexion oubliée : plus aucun brouillon n’est créé dans Infomaniak.' })
    } catch (error) {
      setFeedback({ tone: 'error', text: `Impossible d’oublier la connexion : ${toolboxFailure(error)}.` })
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
            Services externes utilisés par VIPER. Aucun accès n’est transmis au navigateur : la connexion est conservée
            sur le serveur, hors de la base de données.
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

      {status.isPending && <p className="settings-state">Chargement…</p>}
      {status.isError && (
        <div className="settings-state settings-state--error" role="alert">
          <AlertIcon size={18} />
          État de la connexion indisponible.
          <Button size="sm" onClick={() => void status.refetch()}>
            Réessayer
          </Button>
        </div>
      )}
      {status.data && (
        <ToolboxCard
          status={status.data}
          redirecting={redirecting !== null}
          redirectingFor={redirectingFor}
          busy={returning !== null}
          onConnect={() => void connect()}
          onForget={() => {
            setForgetting(true)
          }}
        />
      )}

      <Modal
        open={forgetting}
        size="sm"
        title="Oublier la connexion à la Toolbox ?"
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
            <Button variant="danger" icon={TrashIcon} loading={mutations.forget.isPending} onClick={() => void forget()}>
              Oublier la connexion
            </Button>
          </>
        }
      >
        <div className="settings-dialog">
          <p>
            VIPER efface son accès à la Toolbox. Les prochains messages validés ne créeront plus de brouillon dans
            Infomaniak, et les brouillons déjà créés restent dans la boîte.
          </p>
          <p>
            La Toolbox ne propose pas de révocation : l’accès effacé expire de lui-même à sa date de fin. Vous pourrez
            reconnecter la Toolbox à tout moment.
          </p>
        </div>
      </Modal>
    </>
  )
}

// The scheduled sending (S7): whether a scheduled message really leaves, the dispatcher's last pass, and what waits.
function DispatchFacts({ status }: { status: ToolboxStatus }) {
  const { dispatch } = status
  const badge = dispatchBadge(status)
  return (
    <div className="settings-connection__dispatch">
      <p className="settings-connection__dispatch-title">
        <span>Envoi programmé</span>
        <StatusBadge tone={badge.tone}>{badge.label}</StatusBadge>
      </p>
      <p className="settings-connection__sentence">{dispatchSentence(status)}</p>
      <dl className="settings-connection__facts">
        <div>
          <dt>Dernière passe</dt>
          <dd>
            {dispatch.last_pass_at
              ? `${formatDateTime(dispatch.last_pass_at)}${dispatch.last_outcome === 'error' ? ' (en échec : voir les journaux du serveur)' : ''}`
              : 'aucune depuis le démarrage'}
          </dd>
        </div>
        <div>
          <dt>Messages programmés</dt>
          <dd>{String(dispatch.scheduled)}</dd>
        </div>
        {dispatch.unconfirmed > 0 && (
          <div>
            <dt>Envois non confirmés</dt>
            <dd>{String(dispatch.unconfirmed)} à trancher dans Contact</dd>
          </div>
        )}
      </dl>
    </div>
  )
}

interface ToolboxCardProps {
  status: ToolboxStatus
  redirecting: boolean
  redirectingFor: number
  busy: boolean
  onConnect: () => void
  onForget: () => void
}

function ToolboxCard({ status, redirecting, redirectingFor, busy, onConnect, onForget }: ToolboxCardProps) {
  const badge = STATE_BADGES[status.state]
  const linked = status.state === 'connected' || status.state === 'expired'
  const canConnect = status.configured
  return (
    <section className="settings-connection" aria-labelledby="settings-connection-toolbox">
      <header className="settings-connection__header">
        <span className="settings-connection__icon" aria-hidden="true">
          <MailIcon size={20} />
        </span>
        <div className="settings-connection__heading">
          <h3 id="settings-connection-toolbox" className="settings-connection__title">
            CIRCOE Toolbox
          </h3>
          <p className="settings-connection__subtitle">Brouillons Infomaniak des messages Contact validés</p>
        </div>
        <StatusBadge tone={badge.tone}>{badge.label}</StatusBadge>
      </header>

      <p className="settings-connection__sentence">{stateSentence(status)}</p>

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
          {status.toolbox_origin && (
            <div>
              <dt>Serveur</dt>
              <dd className="settings-connection__mono">{status.toolbox_origin}</dd>
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

      {status.configured && <DispatchFacts status={status} />}

      {status.cleanups.pending > 0 && (
        <p className="settings-connection__note">
          {status.cleanups.pending === 1
            ? '1 brouillon obsolète en attente de suppression dans Infomaniak'
            : `${String(status.cleanups.pending)} brouillons obsolètes en attente de suppression dans Infomaniak`}
          {status.cleanups.failing > 0 ? ` (dont ${String(status.cleanups.failing)} en échec, nouvel essai automatique)` : ''}
          .
        </p>
      )}

      <ul className="settings-connection__limits">
        {LIMITATIONS.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>

      {canConnect && (
        <div className="settings-connection__actions">
          {linked && (
            <Button variant="ghost" icon={TrashIcon} disabled={busy || redirecting} onClick={onForget}>
              Oublier la connexion…
            </Button>
          )}
          <Button
            variant={status.state === 'connected' ? 'secondary' : 'primary'}
            icon={status.state === 'disconnected' ? LinkIcon : RefreshIcon}
            loading={redirecting}
            disabled={busy}
            onClick={onConnect}
          >
            {redirecting
              ? `Ouverture de la Toolbox… ${String(redirectingFor)} s`
              : status.state === 'disconnected'
                ? 'Connecter la Toolbox'
                : 'Reconnecter'}
          </Button>
        </div>
      )}
    </section>
  )
}
