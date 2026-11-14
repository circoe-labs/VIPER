import { useState } from 'react'

import { type CalendlyCheck, type Integrations, useCalendlyEvents, useIntegrations, useIntegrationsMutations } from '../api/integrations'
import { Button } from '../ui/Button'
import { FieldFrame, TextField } from '../ui/fields'
import { AlertIcon, CalendarIcon, SaveIcon, TrashIcon } from '../ui/icons'
import { IntegrationCard, ResetHint, SaveButton, settingInfo, useCardForm, useCardSave } from './IntegrationCards'
import './connections.css'
import { saveRefusal, sourceText } from './integrationsModel'
import { type Feedback, FeedbackBanner } from './shared'

export const CALENDLY_FAILURES: Record<string, string> = {
  calendly_not_configured: 'Aucun jeton enregistré.',
  calendly_unauthorized: 'Calendly refuse ce jeton : il est faux, révoqué, ou son compte n’a pas accès à l’API.',
  calendly_rate_limited: 'Calendly limite temporairement les appels : réessayez dans quelques minutes.',
  calendly_unreachable: 'Calendly ne répond pas : réessayez dans un instant.',
}

const failureText = (code: string | null) => CALENDLY_FAILURES[code ?? ''] ?? 'Calendly n’a pas pu être lu.'

// Config AI › Calendly: the connection (personal access token, write-only like the OpenAI key), the booking link the AI
// writes into mails, and what VIPER reads of the calendar (the same read the agent's tool makes). Two equal cards and a
// full-width list; explanations live in the « i » of each card and field.
export function CalendlySection() {
  const integrations = useIntegrations()
  return (
    <>
      <header className="settings-panel__header">
        <h2 className="settings-panel__title">Calendly</h2>
      </header>
      {integrations.isPending && <p className="settings-state">Chargement…</p>}
      {integrations.isError && (
        <div className="settings-state settings-state--error" role="alert">
          <AlertIcon size={18} />
          Réglages Calendly indisponibles.
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
          <CalendlyCard data={integrations.data} />
          <BookingLinkCard data={integrations.data} />
          <AppointmentsCard data={integrations.data} />
        </div>
      )}
    </>
  )
}

export function CalendlyCard({ data }: { data: Integrations }) {
  const { save, checkCalendly } = useIntegrationsMutations()
  const token = data.calendly_api_token
  const [draft, setDraft] = useState('')
  const [feedback, setFeedback] = useState<Feedback | null>(null)
  // The last « Tester » outcome of this visit: the badge and the account line follow it.
  const [checked, setChecked] = useState<CalendlyCheck | null>(null)

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
  const badge = !token.set
    ? ({ tone: 'neutral', label: 'Non relié' } as const)
    : checked?.ok
      ? ({ tone: 'success', label: 'Connecté' } as const)
      : checked
        ? ({ tone: 'danger', label: 'Jeton refusé' } as const)
        : ({ tone: 'info', label: 'Jeton enregistré' } as const)
  return (
    <IntegrationCard
      id="settings-connection-calendly"
      icon={CalendarIcon}
      title="Connexion Calendly"
      subtitle="VIPER lit vos rendez-vous Calendly (lecture seule) pour l’Agenda, toutes les 10 minutes, et l’agent IA peut les consulter. Dans Calendly : Intégrations et applications › API et webhooks › « Créer un jeton »."
      badge={badge}
    >
      <FieldFrame
        label="Jeton d’accès personnel"
        info={`Collez le jeton créé dans Calendly : il ne s’affiche qu’une fois. VIPER ne le réaffiche jamais, seule sa fin est rappelée. ${source}`}
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
      <FeedbackBanner feedback={feedback} />
      <div className="settings-connection__actions">
        {token.set && token.source === 'ui' && (
          <Button
            variant="ghost"
            icon={TrashIcon}
            disabled={busy}
            onClick={() => void submit(null, 'Jeton retiré : la synchronisation est arrêtée.')}
          >
            Retirer
          </Button>
        )}
        <Button loading={checkCalendly.isPending} disabled={busy || !token.set} onClick={() => void test()}>
          Tester
        </Button>
        <Button
          variant="primary"
          icon={SaveIcon}
          loading={save.isPending}
          disabled={busy || draft.trim() === ''}
          onClick={() => void submit(draft.trim(), 'Jeton enregistré : la synchronisation démarre.')}
        >
          {token.set ? 'Remplacer' : 'Enregistrer'}
        </Button>
      </div>
    </IntegrationCard>
  )
}

// The booking link the AI copies into the mails it drafts (it used to sit in « Rédaction IA »).
function BookingLinkCard({ data }: { data: Integrations }) {
  const form = useCardForm(data)
  const card = useCardSave(data, form)
  const fields = ['contact_booking_url'] as const
  const pending = form.changes(fields)
  const dirty = Object.keys(pending.changes).length > 0
  return (
    <IntegrationCard
      id="settings-connection-booking"
      icon={CalendarIcon}
      title="Lien de prise de rendez-vous"
      subtitle="L’adresse de votre page Calendly que « Générer avec l’IA » recopie telle quelle dans les mails proposés."
    >
      <TextField
        label="Lien de réservation"
        type="url"
        spellCheck={false}
        value={form.value('contact_booking_url')}
        error={form.errors.contact_booking_url}
        disabled={card.saving}
        placeholder="https://calendly.com/…"
        info={settingInfo(data, 'contact_booking_url', 'Recopié tel quel par l’IA dans le mail. Vide : aucun lien proposé.')}
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
      <FeedbackBanner feedback={card.feedback} />
      <div className="settings-connection__actions">
        <SaveButton
          saving={card.saving}
          elapsed={card.elapsed}
          disabled={!dirty}
          onClick={() => {
            if (Object.keys(pending.invalid).length > 0) form.setErrors(pending.invalid)
            else void card.submit(pending.changes, 'Lien enregistré : il s’applique aux prochains mails.', fields)
          }}
        >
          Enregistrer
        </SaveButton>
      </div>
    </IntegrationCard>
  )
}

const DAY = new Intl.DateTimeFormat('fr-FR', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })

// What VIPER reads of the calendar, live from Calendly: the same list the agent's tool answers. Read-only.
function AppointmentsCard({ data }: { data: Integrations }) {
  const events = useCalendlyEvents(data.calendly_api_token.set)
  const failure = events.isError
    ? 'Le serveur VIPER n’a pas répondu.'
    : events.data && !events.data.ok
      ? failureText(events.data.code)
      : null
  return (
    <IntegrationCard
      id="settings-connection-calendly-events"
      wide
      icon={CalendarIcon}
      title="Rendez-vous à venir"
      subtitle="Les 30 prochains jours, lus en direct chez Calendly avec le jeton enregistré. L’agent IA lit la même liste (outil viper_list_calendly_appointments). Rien n’est modifié."
      badge={
        events.data?.ok
          ? { tone: 'success', label: events.data.events.length === 1 ? '1 rendez-vous' : `${String(events.data.events.length)} rendez-vous` }
          : undefined
      }
    >
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
    </IntegrationCard>
  )
}
