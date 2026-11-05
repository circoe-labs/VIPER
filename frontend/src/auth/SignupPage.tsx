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

const MIN_PASSWORD = 12

interface SignupInput {
  email: string
  display_name: string
  password: string
}

interface FieldErrors {
  name?: string
  email?: string
  password?: string
  confirm?: string
}

// `{code}` of a refused request (backend/app/services/signups.py).
const REFUSALS: Record<string, string> = {
  domain: 'Seules les adresses @circoe.com peuvent demander un compte.',
  email: 'L’adresse e-mail n’est pas valide.',
  name: 'Indiquez votre nom.',
  password: `Le mot de passe doit faire au moins ${String(MIN_PASSWORD)} caractères.`,
}

function signupErrorMessage(error: unknown): string {
  if (error instanceof ApiError && error.status === 422) {
    const code = (error.detail as { code?: string } | undefined)?.code
    const message = code ? REFUSALS[code] : undefined
    if (message) return message
  }
  if (error instanceof ApiError && error.status === 429) {
    return 'Trop de demandes. Réessayez dans quelques minutes.'
  }
  return 'La demande n’a pas pu être envoyée. Réessayez dans un instant.'
}

// « Créer un compte »: the account is created deactivated; the platform admin receives an e-mail to confirm it.
export function SignupPage() {
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [errors, setErrors] = useState<FieldErrors>({})
  const signup = useMutation({
    mutationFn: (input: SignupInput) =>
      apiRequest<{ status: string }>('POST', '/auth/signup', { body: input, anonymous: true }),
  })

  function handleSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault()
    const next: FieldErrors = {
      name: name.trim() ? undefined : 'Indiquez votre nom.',
      email: email.trim() ? undefined : 'Saisissez votre adresse e-mail.',
      password: password.length >= MIN_PASSWORD ? undefined : `Au moins ${String(MIN_PASSWORD)} caractères.`,
      confirm: confirm === password ? undefined : 'Les deux mots de passe ne correspondent pas.',
    }
    setErrors(next)
    if (next.name || next.email || next.password || next.confirm) return
    signup.mutate({ email: email.trim(), display_name: name.trim(), password })
  }

  return (
    <div className="login-page">
      <div className="login-page__theme">
        <ThemeSwitch />
      </div>
      <main className="login-card">
        <BrandLogo variant="lockup" height="4.5rem" className="login-card__logo" />
        <div className="login-card__heading">
          <h1 className="login-card__title">Créer un compte</h1>
          <p className="login-card__lead">
            Votre demande est envoyée à l’administrateur, qui confirme le compte avant votre première connexion.
          </p>
        </div>
        {signup.isSuccess ? (
          <>
            <p className="login-card__message login-card__message--info" role="status">
              <CheckCircleIcon size={18} />
              Demande envoyée. Vous pourrez vous connecter dès que l’administrateur aura confirmé votre compte.
            </p>
            <Link className="btn btn--secondary btn--md login-card__submit" to="/login">
              Retour à la connexion
            </Link>
          </>
        ) : (
          <>
            {signup.isError && (
              <p className="login-card__message login-card__message--error" role="alert">
                <AlertIcon size={18} />
                {signupErrorMessage(signup.error)}
              </p>
            )}
            <form className="login-card__form" noValidate onSubmit={handleSubmit}>
              <TextField
                label="Nom complet"
                name="name"
                autoComplete="name"
                autoFocus
                value={name}
                error={errors.name}
                onChange={(event) => {
                  setName(event.target.value)
                }}
              />
              <TextField
                label="Adresse e-mail"
                type="email"
                name="email"
                autoComplete="username"
                spellCheck={false}
                hint="Une adresse @circoe.com."
                value={email}
                error={errors.email}
                onChange={(event) => {
                  setEmail(event.target.value)
                }}
              />
              <TextField
                label="Mot de passe"
                type="password"
                name="password"
                autoComplete="new-password"
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
              <Button type="submit" variant="primary" loading={signup.isPending} className="login-card__submit">
                {signup.isPending ? 'Envoi…' : 'Demander un compte'}
              </Button>
            </form>
            <p className="login-card__alt">
              Déjà un compte ? <Link to="/login">Se connecter</Link>
            </p>
          </>
        )}
      </main>
    </div>
  )
}
