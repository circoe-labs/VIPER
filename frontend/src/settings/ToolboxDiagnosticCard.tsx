import { useState } from 'react'

import { ApiError } from '../api/client'
import {
  DIAGNOSTIC_DELAY,
  type Diagnostic,
  type DiagnosticStep,
  type DiagnosticStepStatus,
  useClearToolboxDiagnostic,
  useStartToolboxDiagnostic,
  useToolboxDiagnostic,
} from '../api/toolboxDiagnostic'
import { formatDateTime } from '../contact/labels'
import { StatusBadge, type StatusTone } from '../ui/Badge'
import { Button } from '../ui/Button'
import { Switch, TextField } from '../ui/fields'
import {
  AlertIcon,
  CheckCircleIcon,
  ClockIcon,
  CopyIcon,
  MailIcon,
  SpinnerIcon,
  TerminalIcon,
  TrashIcon,
} from '../ui/icons'
import { IntegrationCard } from './IntegrationCards'

const STORAGE_KEY = 'viper.toolbox-diagnostic-recipient'
const ADDRESS = /^[^@\s,;<>]+@[^@\s,;<>]+\.[^@\s,;<>]+$/

const STATUS: Record<DiagnosticStepStatus, { tone: StatusTone; label: string }> = {
  pending: { tone: 'neutral', label: 'À venir' },
  running: { tone: 'info', label: 'En cours' },
  ok: { tone: 'success', label: 'Réussi' },
  failed: { tone: 'danger', label: 'Échec' },
  expected_error: { tone: 'success', label: 'Refus attendu' },
  unexpected: { tone: 'warning', label: 'Écart' },
  skipped: { tone: 'neutral', label: 'Ignoré' },
}

function storedRecipient(): string {
  try {
    return window.localStorage.getItem(STORAGE_KEY) ?? ''
  } catch {
    return ''
  }
}

function rememberRecipient(value: string) {
  try {
    window.localStorage.setItem(STORAGE_KEY, value)
  } catch {
    // Private window or blocked storage: the field simply starts empty next time.
  }
}

// Where an error is fixed on this page: the card (by its heading id) and what the button says. The connection codes
// lead to the CIRCOE Toolbox card (« Connecter » / « Reconnecter »), a refused recipient to the Envoi programmé card.
const FIX: Record<string, { target: string; label: string }> = {
  toolbox_not_configured: { target: 'settings-connection-toolbox', label: 'Configurer la Toolbox' },
  toolbox_not_connected: { target: 'settings-connection-toolbox', label: 'Connecter la Toolbox' },
  toolbox_auth_expired: { target: 'settings-connection-toolbox', label: 'Reconnecter la Toolbox' },
  toolbox_connection_interrupted: { target: 'settings-connection-toolbox', label: 'Reconnecter la Toolbox' },
  toolbox_outbound_blocked: { target: 'settings-connection-dispatch', label: 'Voir les adresses autorisées' },
}

function FixLink({ code }: { code: string }) {
  const fix = FIX[code]
  if (!fix) return null
  return (
    <Button
      size="sm"
      onClick={() => {
        const card = document.getElementById(fix.target)
        card?.scrollIntoView({ behavior: 'smooth', block: 'start' })
        card?.closest('section')?.classList.add('settings-connection--pointed')
        window.setTimeout(() => card?.closest('section')?.classList.remove('settings-connection--pointed'), 2500)
      }}
    >
      {fix.label}
    </Button>
  )
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2)
}

function startFailure(error: unknown): string {
  if (error instanceof ApiError && error.status === 409) return 'un test est déjà en cours, attendez qu’il se termine.'
  return error instanceof Error ? error.message : 'erreur inconnue.'
}

// The whole run as text, to paste to the developer: every step with its context, error and raw exchange.
function report(run: Diagnostic): string {
  return json({
    about: 'Rapport « Tester la Toolbox » de VIPER : la trace de chaque étape donne le texte exact renvoyé par la Toolbox.',
    ...run,
  })
}

function Pairs({ title, values }: { title: string; values: Record<string, unknown> }) {
  const entries = Object.entries(values)
  if (entries.length === 0) return null
  return (
    <div className="toolbox-test__block">
      <h5 className="toolbox-test__block-title">{title}</h5>
      <dl className="toolbox-test__pairs">
        {entries.map(([name, value]) => (
          <div key={name} className="toolbox-test__pair">
            <dt>{name}</dt>
            <dd>{typeof value === 'string' ? value : json(value)}</dd>
          </div>
        ))}
      </dl>
    </div>
  )
}

function StepRow({ step }: { step: DiagnosticStep }) {
  const status = STATUS[step.status]
  const open = step.status === 'failed' || step.status === 'unexpected'
  return (
    <details className="toolbox-test__step" open={open || undefined}>
      <summary className="toolbox-test__summary">
        <StatusBadge tone={status.tone} icon={step.status === 'running' ? SpinnerIcon : undefined}>
          {status.label}
        </StatusBadge>
        <span className="toolbox-test__title">{step.title}</span>
        {step.duration_ms !== null && <span className="toolbox-test__duration">{step.duration_ms} ms</span>}
      </summary>
      <div className="toolbox-test__detail">
        <p className="settings-connection__note">Attendu : {step.expectation}</p>
        {step.error && (
          <div className="settings-connection__error" role="alert">
            <AlertIcon size={16} />
            <div>
              <p>
                <strong className="settings-connection__mono">{step.error.code}</strong>
                {step.error.upstream_status !== null && ` · statut HTTP ${String(step.error.upstream_status)}`}
                {step.error.outcome_unknown && ' · issue inconnue (l’opération a pu être exécutée)'}
                {step.error.retryable && ' · peut être rejouée'}
              </p>
              <p>{step.error.message}</p>
              {step.error.toolbox_text && (
                <p>
                  Réponse de la Toolbox : <span className="settings-connection__mono">{step.error.toolbox_text}</span>
                </p>
              )}
              {step.error.hint && <p>Piste : {step.error.hint}</p>}
              <FixLink code={step.error.code} />
            </div>
          </div>
        )}
        {step.note && <p className="settings-connection__note">{step.note}</p>}
        <Pairs title="Contexte" values={step.context} />
        <Pairs title="Constaté" values={step.observed} />
        {step.trace.length > 0 && (
          <details className="toolbox-test__block">
            <summary>Échange brut avec la Toolbox ({step.trace.length})</summary>
            <pre className="toolbox-test__raw">{json(step.trace)}</pre>
          </details>
        )}
      </div>
    </details>
  )
}

function Results({ run }: { run: Diagnostic }) {
  const [copied, setCopied] = useState<'done' | 'failed' | null>(null)
  const clear = useClearToolboxDiagnostic()
  const verdict = run.verdict
  const counts = verdict?.counts ?? {}
  async function copy() {
    try {
      await navigator.clipboard.writeText(report(run))
      setCopied('done')
    } catch {
      setCopied('failed')
    }
  }
  return (
    <section className="toolbox-test__results" aria-label="Résultat du test" aria-live="polite">
      <header className="toolbox-test__verdict">
        {run.status === 'running' && (
          <StatusBadge tone="info" icon={SpinnerIcon}>
            Test en cours…
          </StatusBadge>
        )}
        {verdict?.ok && <StatusBadge tone="success">Tout fonctionne</StatusBadge>}
        {verdict && !verdict.ok && <StatusBadge tone="danger">Problème détecté</StatusBadge>}
        <span className="settings-connection__note">
          {run.send_real ? 'Envoi réel' : 'Brouillons seulement'} · {run.recipient} · lancé le{' '}
          {formatDateTime(run.started_at)}
          {run.status !== 'running' &&
            ` · ${String(counts.ok ?? 0)} réussi(s), ${String(counts.expected_error ?? 0)} refus attendu(s), ${String(counts.failed ?? 0)} échec(s), ${String(counts.unexpected ?? 0)} écart(s), ${String(counts.skipped ?? 0)} ignoré(s)`}
        </span>
        <Button
          size="sm"
          icon={CopyIcon}
          onClick={() => {
            void copy()
          }}
        >
          Copier le rapport
        </Button>
        {run.status !== 'running' && (
          <Button
            size="sm"
            variant="ghost"
            icon={TrashIcon}
            loading={clear.isPending}
            onClick={() => {
              clear.mutate()
            }}
          >
            Effacer le résultat
          </Button>
        )}
        {clear.isError && (
          <span className="settings-connection__note" role="alert">
            Effacement impossible : un test est peut-être en cours.
          </span>
        )}
        {copied && (
          <span className="settings-connection__note" role="status">
            {copied === 'done' ? 'Rapport copié.' : 'Copie impossible : sélectionnez le texte à la main.'}
          </span>
        )}
      </header>
      {verdict?.first_problem && (
        <p className="settings-connection__error" role="alert">
          <AlertIcon size={16} />
          <span>
            Premier problème : « {verdict.first_problem.title} »
            {verdict.first_problem.code && ` (${verdict.first_problem.code})`}.
            {verdict.first_problem.hint && ` ${verdict.first_problem.hint}`}
          </span>
          {verdict.first_problem.code && <FixLink code={verdict.first_problem.code} />}
        </p>
      )}
      {run.crash && (
        <p className="settings-connection__error" role="alert">
          <AlertIcon size={16} />
          Le test s’est arrêté de façon inattendue : {run.crash}
        </p>
      )}
      <div className="toolbox-test__steps">
        {run.steps.map((step) => (
          <StepRow key={step.key} step={step} />
        ))}
      </div>
    </section>
  )
}

// Paramètres › Connexions › « Tester la Toolbox »: one button runs every mail operation against a test address
// (drafts, accents, edit, delete, refusals and — if ticked — a scheduled send for real) and shows each step with its
// context, its error and the raw answer of the Toolbox, to find what breaks without touching a prospect.
export function ToolboxDiagnosticCard() {
  const latest = useToolboxDiagnostic()
  const start = useStartToolboxDiagnostic()
  const [recipient, setRecipient] = useState(storedRecipient)
  const [sendReal, setSendReal] = useState(false)
  const [delay, setDelay] = useState<number>(DIAGNOSTIC_DELAY.default)
  const running = latest.data?.status === 'running' || start.isPending
  const delayValid = !sendReal || (Number.isInteger(delay) && delay >= DIAGNOSTIC_DELAY.min && delay <= DIAGNOSTIC_DELAY.max)
  const recipientValid = ADDRESS.test(recipient.trim())
  const verdict = latest.data?.verdict

  return (
    <IntegrationCard
      id="toolbox-test"
      icon={TerminalIcon}
      title="Tester la Toolbox"
      subtitle="Joue toutes les opérations mail sur une adresse de test et montre où ça casse."
      badge={verdict ? (verdict.ok ? { tone: 'success', label: 'Dernier test réussi' } : { tone: 'danger', label: 'Dernier test en échec' }) : undefined}
    >
      <form
        className="toolbox-test__form"
        onSubmit={(event) => {
          event.preventDefault()
          if (running || !recipientValid || !delayValid) return
          rememberRecipient(recipient.trim())
          start.mutate({ recipient: recipient.trim(), send_real: sendReal, delay_seconds: delay })
        }}
      >
        <TextField
          label="Adresse de test"
          type="email"
          autoComplete="off"
          value={recipient}
          hint="Tous les brouillons et l’envoi réel vont à cette seule adresse : une boîte à vous, jamais un prospect."
          onChange={(event) => {
            setRecipient(event.target.value)
          }}
        />
        <Switch
          label="Envoyer pour de vrai"
          checked={sendReal}
          hint="Un brouillon est programmé, sa date est changée, puis un vrai mail part à l’adresse de test."
          onChange={(event) => {
            setSendReal(event.target.checked)
          }}
        />
        {sendReal && (
          <TextField
            label="Envoi programmé dans (secondes)"
            type="number"
            min={DIAGNOSTIC_DELAY.min}
            max={DIAGNOSTIC_DELAY.max}
            value={delay}
            hint={`Entre ${String(DIAGNOSTIC_DELAY.min)} et ${String(DIAGNOSTIC_DELAY.max)} s ; le test dure un peu plus.`}
            error={delayValid ? undefined : 'Valeur hors limites.'}
            onChange={(event) => {
              setDelay(Number(event.target.value))
            }}
          />
        )}
        {start.isError && (
          <p className="settings-connection__error" role="alert">
            <AlertIcon size={16} />
            Impossible de lancer le test : {startFailure(start.error)}
          </p>
        )}
        <div className="settings-connection__actions">
          <Button
            type="submit"
            variant="primary"
            icon={sendReal ? MailIcon : CheckCircleIcon}
            loading={running}
            disabled={!recipientValid || !delayValid}
          >
            {running ? 'Test en cours…' : 'Lancer le diagnostic'}
          </Button>
        </div>
      </form>
      {latest.isError && (
        <p className="settings-connection__error" role="alert">
          <AlertIcon size={16} />
          Dernier résultat indisponible.
        </p>
      )}
      {latest.data && <Results run={latest.data} />}
      {latest.data === null && (
        <p className="settings-connection__note">
          <ClockIcon size={14} /> Aucun test lancé depuis le démarrage du serveur.
        </p>
      )}
    </IntegrationCard>
  )
}
