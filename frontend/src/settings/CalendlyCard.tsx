import { useState } from 'react'

import { type Integrations, useIntegrationsMutations } from '../api/integrations'
import { Button } from '../ui/Button'
import { FieldFrame } from '../ui/fields'
import { CalendarIcon, SaveIcon, TrashIcon } from '../ui/icons'
import { IntegrationCard } from './IntegrationCards'
import { saveRefusal, sourceText } from './integrationsModel'
import { type Feedback, FeedbackBanner } from './shared'

const CHECK_FAILURES: Record<string, string> = {
  calendly_not_configured: 'Aucun jeton enregistré.',
  calendly_unauthorized: 'Calendly refuse ce jeton : il est faux, révoqué, ou son compte n’a pas accès à l’API.',
  calendly_rate_limited: 'Calendly limite temporairement les appels : réessayez dans quelques minutes.',
  calendly_unreachable: 'Calendly ne répond pas : réessayez dans un instant.',
}

// Paramètres › Connexions › Calendly (Agenda): the personal access token VIPER uses, read-only, to bring the booked
// meetings into the Agenda. Write-only like the OpenAI key: only its last four characters are ever shown back.
export function CalendlyCard({ data }: { data: Integrations }) {
  const { save, checkCalendly } = useIntegrationsMutations()
  const token = data.calendly_api_token
  const [draft, setDraft] = useState('')
  const [feedback, setFeedback] = useState<Feedback | null>(null)

  async function submit(next: string | null, success: string) {
    setFeedback(null)
    try {
      await save.mutateAsync({ version: data.version, changes: { calendly_api_token: next } })
      setDraft('')
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
      setFeedback(
        result.ok
          ? { tone: 'success', text: `Jeton valide${result.account ? ` — compte ${result.account}` : ''}.` }
          : { tone: 'error', text: CHECK_FAILURES[result.code ?? ''] ?? 'Le jeton n’a pas pu être vérifié.' },
      )
    } catch {
      setFeedback({ tone: 'error', text: 'Le test n’a pas abouti : réessayez.' })
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
    <IntegrationCard
      id="settings-connection-calendly"
      icon={CalendarIcon}
      title="Calendly"
      subtitle="Rapatrie les rendez-vous pris dans l’Agenda (lecture seule, toutes les 10 minutes)"
      badge={token.set ? { tone: 'success', label: 'Jeton enregistré' } : { tone: 'neutral', label: 'Non relié' }}
    >
      <div className="settings-form">
        <FieldFrame
          label="Jeton d’accès personnel Calendly"
          hint={
            <>
              <span className="settings-setting__help">
                Dans Calendly : Intégrations et applications › API et webhooks › « Créer un jeton ». Il ne s’affiche
                qu’une fois : collez-le ici. Jamais réaffiché : seule sa fin est rappelée.
              </span>
              <span className="settings-setting__source">{source}</span>
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
      <FeedbackBanner feedback={feedback} />
      <div className="settings-connection__actions">
        <Button
          variant="primary"
          icon={SaveIcon}
          loading={save.isPending}
          disabled={busy || draft.trim() === ''}
          onClick={() => void submit(draft.trim(), 'Jeton enregistré : la synchronisation démarre.')}
        >
          {token.set ? 'Remplacer le jeton' : 'Enregistrer le jeton'}
        </Button>
        <Button loading={checkCalendly.isPending} disabled={busy || !token.set} onClick={() => void test()}>
          Tester le jeton
        </Button>
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
      </div>
    </IntegrationCard>
  )
}
