import { useState } from 'react'
import { useSearchParams } from 'react-router'

import { useOAuthDecision, useOAuthRequest } from '../api/oauth'
import { Button } from '../ui/Button'
import { Card } from '../ui/Card'
import './oauth-consent.css'

// « Autoriser … à accéder à VIPER ? » (`/autoriser?demande=<id>`): where `/oauth/authorize` sends the person when a
// connector (ChatGPT, Claude…) asks for MCP access. The page sits behind the sign-in like every page: approving needs
// the person's VIPER session. `?erreur=` carries a refusal the server would not send back to an untrusted address.
export function OAuthConsentPage() {
  const [params] = useSearchParams()
  const requestId = params.get('demande')
  const refused = params.get('erreur')
  const request = useOAuthRequest(refused ? null : requestId)
  const decision = useOAuthDecision(requestId ?? '')
  const [leaving, setLeaving] = useState<'approve' | 'deny' | null>(null)

  const decide = (choice: 'approve' | 'deny') => {
    decision.mutate(choice, {
      onSuccess: ({ redirect }) => {
        setLeaving(choice)
        window.location.assign(redirect)
      },
    })
  }

  if (refused || !requestId) {
    return (
      <div className="oauth-consent">
        <Card title="Connexion refusée">
          <p className="oauth-consent__text">
            {refused ?? 'Aucune demande d’autorisation.'} Recommencez la connexion depuis l’application qui l’a demandée.
          </p>
        </Card>
      </div>
    )
  }
  if (request.isLoading) return <p className="oauth-consent oauth-consent__muted">Chargement de la demande…</p>
  if (request.isError || !request.data) {
    return (
      <div className="oauth-consent">
        <Card title="Demande expirée">
          <p className="oauth-consent__text">
            Cette demande d’autorisation est inconnue, expirée ou déjà traitée. Recommencez la connexion depuis
            l’application qui l’a demandée.
          </p>
        </Card>
      </div>
    )
  }

  const { client_name: name, redirect_host: host } = request.data
  return (
    <div className="oauth-consent">
      <Card title={`Autoriser « ${name} » à accéder à VIPER ?`}>
        <div className="oauth-consent__body">
          <p className="oauth-consent__text">
            <strong>{name}</strong> (retour vers <code>{host}</code>) demande à utiliser le serveur MCP de VIPER en votre
            nom. Il pourra :
          </p>
          <ul className="oauth-consent__list">
            <li>lire les sociétés et les prospects ;</li>
            <li>prendre les tâches des missions et proposer des résultats, que vous validez dans Missions ;</li>
            <li>proposer des modifications de fiches, jamais appliquées sans votre validation.</li>
          </ul>
          <p className="oauth-consent__muted">
            L’accès apparaît dans Paramètres › MCP › Accès autorisés, où vous pouvez le révoquer à tout moment.
          </p>
          {decision.isError && (
            <p className="oauth-consent__error" role="alert">
              La demande n’a pas pu être traitée (expirée ou déjà utilisée) : recommencez depuis l’application.
            </p>
          )}
          {leaving && (
            <p className="oauth-consent__muted" role="status">
              {leaving === 'approve' ? 'Accès accordé' : 'Accès refusé'} : retour vers {name}…
            </p>
          )}
          <div className="oauth-consent__actions">
            <Button
              variant="secondary"
              disabled={decision.isPending || leaving !== null}
              onClick={() => {
                decide('deny')
              }}
            >
              Refuser
            </Button>
            <Button
              variant="primary"
              loading={decision.isPending && decision.variables === 'approve'}
              disabled={decision.isPending || leaving !== null}
              onClick={() => {
                decide('approve')
              }}
            >
              Autoriser
            </Button>
          </div>
        </div>
      </Card>
    </div>
  )
}
