import { useMutation } from '@tanstack/react-query'
import { type SubmitEvent, useState } from 'react'
import { Link } from 'react-router'

import { ApiError, apiRequest } from '../api/client'
import { BrandLogo } from '../brand/BrandLogo'
import { ThemeSwitch } from '../theme/ThemeSwitch'
import { Button } from '../ui/Button'
import { TextField } from '../ui/fields'
import { AlertIcon, CheckCircleIcon } from '../ui/icons'
import './auth.css'

function forgotErrorMessage(error: unknown): string {
  if (error instanceof ApiError && error.status === 429) {
    return 'Trop de demandes. Réessayez dans quelques minutes.'
  }
  return 'La demande n’a pas pu être envoyée. Réessayez dans un instant.'
}

// « Mot de passe oublié ? »: the answer is the same whether or not the address has an account (no enumeration).
export function ForgotPasswordPage() {
  const [email, setEmail] = useState('')
  const [error, setError] = useState<string>()
  const forgot = useMutation({
    mutationFn: (address: string) =>
      apiRequest<{ status: string }>('POST', '/auth/forgot-password', {
        body: { email: address },
        anonymous: true,
      }),
  })

  function handleSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!email.trim()) {
      setError('Saisissez votre adresse e-mail.')
      return
    }
    setError(undefined)
    forgot.mutate(email.trim())
  }

  return (
    <div className="login-page">
      <div className="login-page__theme">
        <ThemeSwitch />
      </div>
      <main className="login-card">
        <BrandLogo variant="lockup" height="4.5rem" className="login-card__logo" />
        <div className="login-card__heading">
          <h1 className="login-card__title">Mot de passe oublié</h1>
          <p className="login-card__lead">
            Saisissez votre adresse e-mail : vous recevrez un lien pour choisir un nouveau mot de passe.
          </p>
        </div>
        {forgot.isSuccess ? (
          <>
            <p className="login-card__message login-card__message--info" role="status">
              <CheckCircleIcon size={18} />
              Si un compte actif existe pour cette adresse, un e-mail avec un lien de réinitialisation vient
              d’être envoyé.
            </p>
            <Link className="btn btn--secondary btn--md login-card__submit" to="/login">
              Retour à la connexion
            </Link>
          </>
        ) : (
          <>
            {forgot.isError && (
              <p className="login-card__message login-card__message--error" role="alert">
                <AlertIcon size={18} />
                {forgotErrorMessage(forgot.error)}
              </p>
            )}
            <form className="login-card__form" noValidate onSubmit={handleSubmit}>
              <TextField
                label="Adresse e-mail"
                type="email"
                name="email"
                autoComplete="username"
                spellCheck={false}
                autoFocus
                value={email}
                error={error}
                onChange={(event) => {
                  setEmail(event.target.value)
                }}
              />
              <Button type="submit" variant="primary" loading={forgot.isPending} className="login-card__submit">
                {forgot.isPending ? 'Envoi…' : 'Envoyer le lien'}
              </Button>
            </form>
            <p className="login-card__alt">
              <Link to="/login">Retour à la connexion</Link>
            </p>
          </>
        )}
      </main>
    </div>
  )
}
