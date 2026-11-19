import { useState } from 'react'

import {
  type CalendlyCheck,
  type Integrations,
  useCalendlyEvents,
  useIntegrationsMutations,
} from '../../api/integrations'
import { ResetHint, SaveButton, settingInfo, useCardForm, useCardSave } from '../../settings/IntegrationCards'
import { saveRefusal, sourceText } from '../../settings/integrationsModel'
import { type Feedback, FeedbackBanner } from '../../settings/shared'
import { StatusBadge } from '../../ui/Badge'
import { Button, IconButton } from '../../ui/Button'
import { FieldFrame, TextField } from '../../ui/fields'
import { AlertIcon, CheckCircleIcon, PlayIcon, RefreshIcon, TrashIcon } from '../../ui/icons'
import { CalendlyLogo } from '../logos'
import { type Connection, Pane, PaneActions } from './connection'

export const CALENDLY_FAILURES: Record<string, string> = {
  calendly_not_configured: 'Aucun jeton enregistré.',
  calendly_unauthorized: 'Calendly refuse ce jeton : il est faux, révoqué, ou son compte n’a pas accès à l’API.',
  calendly_rate_limited: 'Calendly limite temporairement les appels : réessayez dans quelques minutes.',
  calendly_unreachable: 'Calendly ne répond pas : réessayez dans un instant.',
}

const failureText = (code: string | null) => CALENDLY_FAILURES[code ?? ''] ?? 'Calendly n’a pas pu être lu.'

// Calendly: the personal access token, the booking link the AI writes into mails, and the next meetings read live —
// one connection, three tabs (it is a connection like any other: if the service changes, only this descriptor does).
export function useCalendlyConnection(data: Integrations): Connection {
  const { checkCalendly } = useIntegrationsMutations()
  const token = data.calendly_api_token
  const link = data.fields.contact_booking_url.value
  return {
    id: 'calendly',
    title: 'Calendly',
    Logo: CalendlyLogo,
    summary: typeof link === 'string' && link !== '' ? link.replace(/^https?:\/\//, '') : 'Lien de réservation non défini',
    about:
      'VIPER lit vos rendez-vous Calendly (lecture seule) pour l’Agenda, toutes les 10 minutes, et l’agent IA peut les consulter. Le lien de réservation est recopié par l’IA dans les mails proposés.',
    badge: token.set ? { tone: 'info', label: 'Jeton enregistré' } : { tone: 'neutral', label: 'Non relié' },
    quickTest: {
      label: 'Tester la connexion Calendly',
      pending: checkCalendly.isPending,
      disabled: !token.set,
      disabledReason: 'Enregistrez d’abord un jeton',
      run: async () => {
        try {
          const result = await checkCalendly.mutateAsync()
          return result.ok
            ? { tone: 'success', label: 'Connecté', detail: result.account ? `Compte Calendly : ${result.account}` : undefined }
            : { tone: 'danger', label: 'Jeton refusé', detail: failureText(result.code) }
        } catch {
          return { tone: 'warning', label: 'Test impossible', detail: 'Le serveur VIPER n’a pas répondu, réessayez.' }
        }
      },
    },
    tabs: [
      { id: 'connection', label: 'Connexion' },
      { id: 'booking', label: 'Lien de rendez-vous' },
      { id: 'events', label: 'Rendez-vous à venir' },
    ],
    body: <CalendlyBody data={data} />,
  }
}

function CalendlyBody({ data }: { data: Integrations }) {
  const { save, checkCalendly } = useIntegrationsMutations()
  const token = data.calendly_api_token
  const [draft, setDraft] = useState('')
  const [feedback, setFeedback] = useState<Feedback | null>(null)
  // The last « Tester » outcome of this visit: the account line follows it.
  const [checked, setChecked] = useState<CalendlyCheck | null>(null)
  const form = useCardForm(data)
  const card = useCardSave(data, form)
  const pending = form.changes(['contact_booking_url'])
  const bookingDirty = Object.keys(pending.changes).length > 0

  async function submit(next: string | null, success: string) {
    setFeedback(null)
    try {
      await save.mutateAsync({ version: data.version, changes: { calendly_api_token: next } })
      setDraft('')
      setChecked(null)
      save.reset()
      setFeedback({ tone: 'success', text: success })
    } catch (error) {
      setFeedback({ tone: 'error', text: saveRefusal(error).message })
    }
  }

  async function test() {
    setFeedback(null)
    try {
      const result = await checkCalendly.mutateAsync()
      setChecked(result)
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
        ? 'Jeton fourni par la configuration du serveur.'
        : 'Aucun jeton enregistré.'
  const busy = save.isPending || checkCalendly.isPending

  return (
    <>
      <Pane id="connection">
        <div className="settings-form">
          <FieldFrame
            label="Jeton d’accès personnel"
            info={`Dans Calendly : Intégrations et applications › API et webhooks › « Créer un jeton ». Il ne s’affiche qu’une fois : VIPER ne le réaffiche jamais, seule sa fin est rappelée. ${source}`}
            hint={checked?.ok && checked.account ? `Compte Calendly : ${checked.account}` : undefined}
          >
            {(a11y) => (
              <input
                {...a11y}
                type="password"
                className="field__control"
                autoComplete="new-password"
                spellCheck={false}
                placeholder={token.set ? `•••• ${token.last4 ?? ''} (enregistré)` : 'Collez le jeton'}
                disabled={busy}
                value={draft}
                onChange={(event) => {
                  setDraft(event.target.value)
                }}
              />
            )}
          </FieldFrame>
        </div>
        {checked?.ok && (
          <p className="settings-feedback settings-feedback--success">
            <CheckCircleIcon size={18} />
            Connecté{checked.account ? ` : ${checked.account}` : ''}.
          </p>
        )}
        <PaneActions
          secondary={
            <>
              <IconButton
                icon={PlayIcon}
                label="Tester"
                title="Tester le jeton auprès de Calendly"
                loading={checkCalendly.isPending}
                disabled={busy || !token.set}
                onClick={() => void test()}
              />
              {token.set && token.source === 'ui' && (
                <IconButton
                  icon={TrashIcon}
                  label="Retirer"
                  title="Retirer le jeton : la synchronisation s’arrête"
                  disabled={busy}
                  onClick={() => void submit(null, 'Jeton retiré : la synchronisation est arrêtée.')}
                />
              )}
            </>
          }
        >
          <Button
            variant="primary"
            loading={save.isPending}
            disabled={busy || draft.trim() === ''}
            onClick={() => void submit(draft.trim(), 'Jeton enregistré : la synchronisation démarre.')}
          >
            {token.set ? 'Remplacer' : 'Enregistrer'}
          </Button>
        </PaneActions>
      </Pane>

      <Pane id="booking">
        <div className="settings-form">
          <TextField
            label="Lien de réservation"
            type="url"
            spellCheck={false}
            value={form.value('contact_booking_url')}
            error={form.errors.contact_booking_url}
            disabled={card.saving}
            placeholder="https://calendly.com/…"
            info={settingInfo(data, 'contact_booking_url', 'L’adresse de votre page Calendly que « Générer avec l’IA » recopie telle quelle dans les mails. Vide : aucun lien proposé.')}
            hint={
              <ResetHint
                data={data}
                field="contact_booking_url"
                busy={card.saving}
                onReset={(field) => void card.submit({ [field]: null }, 'Valeur par défaut rétablie.', [field])}
              />
            }
            onChange={(event) => {
              form.edit('contact_booking_url', event.target.value)
            }}
          />
        </div>
        <PaneActions>
          <SaveButton
            saving={card.saving}
            elapsed={card.elapsed}
            disabled={!bookingDirty}
            onClick={() => {
              if (Object.keys(pending.invalid).length > 0) form.setErrors(pending.invalid)
              else void card.submit(pending.changes, 'Lien enregistré : il s’applique aux prochains mails.', ['contact_booking_url'])
            }}
          >
            Enregistrer
          </SaveButton>
        </PaneActions>
      </Pane>

      <Pane id="events">
        <Appointments data={data} />
      </Pane>

      <FeedbackBanner feedback={feedback ?? card.feedback} />
    </>
  )
}

const DAY = new Intl.DateTimeFormat('fr-FR', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })

// What VIPER reads of the calendar, live from Calendly: the same list the agent's tool answers. Read-only.
function Appointments({ data }: { data: Integrations }) {
  const events = useCalendlyEvents(data.calendly_api_token.set)
  const failure = events.isError
    ? 'Le serveur VIPER n’a pas répondu.'
    : events.data && !events.data.ok
      ? failureText(events.data.code)
      : null
  return (
    <>
      <PaneActions
        secondary={
          <IconButton
            icon={RefreshIcon}
            label="Actualiser"
            loading={events.isFetching}
            disabled={!data.calendly_api_token.set}
            onClick={() => {
              void events.refetch()
            }}
          />
        }
      />
      {events.data?.ok && (
        <div>
          <StatusBadge tone="success">
            {events.data.events.length === 1 ? '1 rendez-vous' : `${String(events.data.events.length)} rendez-vous`} dans les 30 prochains jours
          </StatusBadge>
        </div>
      )}
      {!data.calendly_api_token.set && <p className="settings-state">Enregistrez un jeton pour lire vos rendez-vous.</p>}
      {data.calendly_api_token.set && events.isPending && <p className="settings-state">Lecture de Calendly…</p>}
      {failure && (
        <div className="settings-state settings-state--error" role="alert">
          <AlertIcon size={18} />
          {failure}
          <Button
            size="sm"
            onClick={() => {
              void events.refetch()
            }}
          >
            Réessayer
          </Button>
        </div>
      )}
      {events.data?.ok && events.data.events.length === 0 && (
        <p className="settings-state">Aucun rendez-vous dans les 30 prochains jours.</p>
      )}
      {events.data?.ok && events.data.events.length > 0 && (
        <ul className="settings-appointments" aria-label="Rendez-vous à venir">
          {events.data.events.map((event) => (
            <li key={event.uri ?? `${event.title}-${event.starts_at ?? ''}`}>
              <time dateTime={event.starts_at ?? undefined}>{event.starts_at ? DAY.format(new Date(event.starts_at)) : '—'}</time>
              <strong>{event.title}</strong>
              <span className="settings-connection__note">
                {event.invitees.map((invitee) => invitee.name ?? invitee.email ?? 'Invité').join(', ') || 'Sans invité'}
              </span>
            </li>
          ))}
        </ul>
      )}
    </>
  )
}
