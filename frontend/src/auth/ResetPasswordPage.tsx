import { useMutation } from '@tanstack/react-query'
import { type SubmitEvent, useState } from 'react'
import { Link, useParams } from 'react-router'

import { ApiError, apiRequest } from '../api/client'
import { BrandLogo } from '../brand/BrandLogo'
import { ThemeSwitch } from '../theme/ThemeSwitch'
import { Button } from '../ui/Button'
import { TextField } from '../ui/fields'
import { AlertIcon, CheckCircleIcon } from '../ui/icons'
import './auth.css'

const MIN_PASSWORD = 12

interface FieldErrors {
  password?: string
  confirm?: string
}

function refusalCode(error: unknown): string | undefined {
  if (error instanceof ApiError && error.status === 422) {
    return (error.detail as { code?: string } | undefined)?.code
  }
  return undefined
}

function resetErrorMessage(error: unknown): string {
  if (refusalCode(error) === 'password') {
    return `Le mot de passe doit faire au moins ${String(MIN_PASSWORD)} caractères.`
  }
  if (error instanceof ApiError && error.status === 429) {
    return 'Trop de tentatives. Réessayez dans quelques minutes.'
  }
  return 'Le mot de passe n’a pas pu être modifié. Réessayez dans un instant.'
}

// The link of the e-mail sent by « Mot de passe oublié ? » or by an administrator (`/reinitialisation/<token>`).
export function ResetPasswordPage() {
  const { token = '' } = useParams()
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [errors, setErrors] = useState<FieldErrors>({})
  const reset = useMutation({
    mutationFn: (newPassword: string) =>
      apiRequest<unknown>('POST', '/auth/reset-password', {
        body: { token, password: newPassword },
        anonymous: true,
      }),
  })

  function handleSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault()
    const next: FieldErrors = {
      password: password.length >= MIN_PASSWORD ? undefined : `Au moins ${String(MIN_PASSWORD)} caractères.`,
      confirm: confirm === password ? undefined : 'Les deux mots de passe ne correspondent pas.',
    }
    setErrors(next)
    if (next.password || next.confirm) return
    reset.mutate(password)
  }

  const tokenDead = refusalCode(reset.error) === 'token'

  return (
    <div className="login-page">
      <div className="login-page__theme">
        <ThemeSwitch />
      </div>
      <main className="login-card">
        <BrandLogo variant="lockup" height="4.5rem" className="login-card__logo" />
        <div className="login-card__heading">
          <h1 className="login-card__title">Nouveau mot de passe</h1>
          <p className="login-card__lead">Choisissez le mot de passe de votre compte VIPER.</p>
        </div>
        {reset.isSuccess ? (
          <>
            <p className="login-card__message login-card__message--info" role="status">
              <CheckCircleIcon size={18} />
              Mot de passe modifié. Vous pouvez maintenant vous connecter.
            </p>
            <Link className="btn btn--primary btn--md login-card__submit" to="/login">
              Se connecter
            </Link>
          </>
        ) : tokenDead ? (
          <>
            <p className="login-card__message login-card__message--error" role="alert">
              <AlertIcon size={18} />
              Ce lien est invalide ou a expiré. Un lien n’est valable qu’une heure et une seule fois.
            </p>
            <Link className="btn btn--primary btn--md login-card__submit" to="/mot-de-passe-oublie">
              Demander un nouveau lien
            </Link>
          </>
        ) : (
          <>
            {reset.isError && (
              <p className="login-card__message login-card__message--error" role="alert">
                <AlertIcon size={18} />
                {resetErrorMessage(reset.error)}
              </p>
            )}
            <form className="login-card__form" noValidate onSubmit={handleSubmit}>
              <TextField
                label="Nouveau mot de passe"
                type="password"
                name="password"
                autoComplete="new-password"
                autoFocus
                hint={`Au moins ${String(MIN_PASSWORD)} caractères.`}
                value={password}
                error={errors.password}
                onChange={(event) => {
                  setPassword(event.target.value)
                }}
              />
              <TextField
                label="Confirmer le mot de passe"
                type="password"
                name="confirm"
                autoComplete="new-password"
                value={confirm}
                error={errors.confirm}
                onChange={(event) => {
                  setConfirm(event.target.value)
                }}
              />
              <Button type="submit" variant="primary" loading={reset.isPending} className="login-card__submit">
                {reset.isPending ? 'Enregistrement…' : 'Changer le mot de passe'}
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
