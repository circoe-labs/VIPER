import { type SubmitEvent, useRef, useState } from 'react'
import { Navigate, useLocation } from 'react-router'

import { ApiError } from '../api/client'
import { BrandLogo } from '../brand/BrandLogo'
import { ThemeSwitch } from '../theme/ThemeSwitch'
import { Button } from '../ui/Button'
import { TextField } from '../ui/fields'
import { AlertIcon, InfoIcon } from '../ui/icons'
import { readLoginState } from './loginState'
import { useLogin, useSession } from './session'
import './auth.css'

interface FieldErrors {
  email?: string
  password?: string
}

const NOTICES = {
  expired: 'Votre session a expiré. Reconnectez-vous pour continuer.',
  'signed-out': 'Vous êtes déconnecté.',
} as const

function loginErrorMessage(error: unknown): string {
  if (error instanceof ApiError && error.status === 401) return 'Adresse e-mail ou mot de passe incorrect.'
  if (error instanceof ApiError && error.status === 429) {
    return 'Trop de tentatives de connexion. Réessayez dans quelques minutes.'
  }
  return 'Connexion impossible pour le moment. Vérifiez votre connexion puis réessayez.'
}

export function LoginPage() {
  const session = useSession()
  const location = useLocation()
  const login = useLogin()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({})
  const emailRef = useRef<HTMLInputElement>(null)
  const passwordRef = useRef<HTMLInputElement>(null)
  const { reason, from } = readLoginState(location.state)

  // Signed in (already, or just now): continue to the page that was asked for.
  if (session.data?.status === 'authenticated') return <Navigate to={from ?? '/'} replace />

  function handleSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault()
    const errors: FieldErrors = {
      email: email.trim() ? undefined : 'Saisissez votre adresse e-mail.',
      password: password ? undefined : 'Saisissez votre mot de passe.',
    }
    setFieldErrors(errors)
    if (errors.email || errors.password) {
      const firstInvalid = errors.email ? emailRef : passwordRef
      firstInvalid.current?.focus()
      return
    }
    login.mutate(
      { email: email.trim(), password },
      {
        onError: () => {
          setPassword('')
          passwordRef.current?.focus()
        },
      },
    )
  }

  const notice = reason === 'initial' || login.isError ? null : NOTICES[reason]

  return (
    <div className="login-page">
      <div className="login-page__theme">
        <ThemeSwitch />
      </div>
      <main className="login-card">
        <BrandLogo variant="lockup" height="4.5rem" className="login-card__logo" />
        <div className="login-card__heading">
          <h1 className="login-card__title">Connexion</h1>
          <p className="login-card__lead">Connectez-vous pour accéder à votre espace de prospection.</p>
        </div>
        {notice && (
          <p className="login-card__message login-card__message--info" role="status">
            <InfoIcon size={18} />
            {notice}
          </p>
        )}
        {login.isError && (
          <p className="login-card__message login-card__message--error" role="alert">
            <AlertIcon size={18} />
            {loginErrorMessage(login.error)}
          </p>
        )}
        <form className="login-card__form" noValidate onSubmit={handleSubmit}>
          <TextField
            ref={emailRef}
            label="Adresse e-mail"
            type="email"
            name="email"
            autoComplete="username"
            spellCheck={false}
            autoFocus
            value={email}
            error={fieldErrors.email}
            onChange={(event) => {
              setEmail(event.target.value)
            }}
          />
          <TextField
            ref={passwordRef}
            label="Mot de passe"
            type="password"
            name="password"
            autoComplete="current-password"
            value={password}
            error={fieldErrors.password}
            onChange={(event) => {
              setPassword(event.target.value)
            }}
          />
          <Button type="submit" variant="primary" loading={login.isPending} className="login-card__submit">
            {login.isPending ? 'Connexion…' : 'Se connecter'}
          </Button>
        </form>
      </main>
    </div>
  )
}
