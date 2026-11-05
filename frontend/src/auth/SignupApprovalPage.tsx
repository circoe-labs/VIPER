import { useMutation, useQuery } from '@tanstack/react-query'
import { Link, useParams } from 'react-router'

import { ApiError, apiGet, apiRequest } from '../api/client'
import { Button } from '../ui/Button'
import { Card } from '../ui/Card'
import { PageHeader } from '../ui/PageHeader'
import './auth.css'

interface Signup {
  email: string
  display_name: string
  organization: string
  requested_at: string | null
}

type Decision = 'approve' | 'refuse'

function failure(error: unknown): string {
  if (error instanceof ApiError && error.status === 404) {
    return 'Cette demande n’existe plus : elle a déjà été confirmée ou refusée.'
  }
  if (error instanceof ApiError && error.status === 403) {
    return 'Seul un administrateur peut confirmer ou refuser une demande de compte.'
  }
  return 'La demande n’a pas pu être traitée. Réessayez dans un instant.'
}

// The link of the e-mail sent to the platform admin when someone asks for an account (`/inscriptions/<token>`).
export function SignupApprovalPage() {
  const { token = '' } = useParams()
  const path = `/auth/signups/${encodeURIComponent(token)}` as const
  const request = useQuery({
    queryKey: ['signup', token],
    queryFn: ({ signal }) => apiGet<Signup>(path, signal),
    retry: false,
  })
  const decide = useMutation({
    mutationFn: (decision: Decision) => apiRequest<unknown>('POST', `${path}/${decision}`),
  })

  return (
    <>
      <PageHeader title="Demande de compte" description="Confirmez ou refusez l’accès à VIPER." />
      <Card title="Demande">
        {request.isLoading && <p className="settings-muted">Chargement…</p>}
        {request.isError && <p className="settings-error">{failure(request.error)}</p>}
        {request.data && !decide.isSuccess && (
          <>
            <p>
              <strong>{request.data.display_name}</strong> ({request.data.email}) demande un compte dans
              l’organisation {request.data.organization}
              {request.data.requested_at
                ? `, le ${new Date(request.data.requested_at).toLocaleString('fr-FR')}`
                : ''}
              .
            </p>
            {decide.isError && <p className="settings-error">{failure(decide.error)}</p>}
            <div className="signup-approval__actions">
              <Button
                variant="primary"
                loading={decide.isPending && decide.variables === 'approve'}
                disabled={decide.isPending}
                onClick={() => {
                  decide.mutate('approve')
                }}
              >
                Confirmer le compte
              </Button>
              <Button
                variant="secondary"
                loading={decide.isPending && decide.variables === 'refuse'}
                disabled={decide.isPending}
                onClick={() => {
                  decide.mutate('refuse')
                }}
              >
                Refuser
              </Button>
            </div>
          </>
        )}
        {decide.isSuccess && (
          <p>
            {decide.variables === 'approve'
              ? 'Compte confirmé : la personne peut maintenant se connecter. '
              : 'Demande refusée : le compte a été supprimé. '}
            <Link to="/organisation">Voir l’organisation</Link>
          </p>
        )}
      </Card>
    </>
  )
}
