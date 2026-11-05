import { type SubmitEvent, useRef, useState } from 'react'
import { Link, Navigate, useLocation, useSearchParams } from 'react-router'

import { ApiError } from '../api/client'
import { BrandLogo } from '../brand/BrandLogo'
import { ThemeSwitch } from '../theme/ThemeSwitch'
import { Button } from '../ui/Button'
import { TextField } from '../ui/fields'
import { AlertIcon, InfoIcon, KeyIcon } from '../ui/icons'
import { readLoginState } from './loginState'
import { useLogin, useSession, useSignInMethods } from './session'
import './auth.css'

interface FieldErrors {
  email?: string
  password?: string
}

const NOTICES = {
  expired: 'Votre session a expiré. Reconnectez-vous pour continuer.',
  'signed-out': 'Vous êtes déconnecté.',
} as const

// `?erreur=` set by the Infomaniak callback (backend/app/api/routes/auth.py) when it does not open a session.
const SIGN_IN_REFUSALS: Record<string, string> = {
  domain: 'Adresse e-mail non autorisée.',
  pending: 'Votre compte attend la confirmation de l’administrateur.',
  inactive: 'Ce compte est désactivé. Contactez un administrateur de votre organisation.',
  organization: 'Votre organisation n’est pas encore ouverte.',
  unverified: 'Votre adresse Infomaniak n’est pas vérifiée.',
  mismatch: 'Cette adresse est déjà liée à un autre compte Infomaniak.',
  cancelled: 'Connexion Infomaniak annulée.',
  expired: 'La connexion a expiré : recommencez.',
  infomaniak: 'Infomaniak n’a pas répondu : réessayez dans un instant.',
  unavailable: 'La connexion Infomaniak n’est pas configurée sur ce serveur.',
}

function loginErrorMessage(error: unknown): string {
  if (error instanceof ApiError && error.status === 401) return 'Adresse e-mail ou mot de passe incorrect.'
  if (error instanceof ApiError && error.status === 403) {
    const code = (error.detail as { code?: string } | undefined)?.code
    if (code === 'pending') return 'Votre compte attend la confirmation de l’administrateur.'
    // No reason given for an address outside the open domains: the rule is not shown to visitors.
    if (code === 'domain') return 'Adresse e-mail non autorisée.'
    return 'Connexion refusée : ce compte n’est pas actif.'
  }
  if (error instanceof ApiError && error.status === 429) {
    return 'Trop de tentatives de connexion. Réessayez dans quelques minutes.'
  }
  return 'Connexion impossible pour le moment. Vérifiez votre connexion puis réessayez.'
}

export function LoginPage() {
  const session = useSession()
  const location = useLocation()
  const login = useLogin()
  const methods = useSignInMethods()
  const [params] = useSearchParams()
  const refusal = params.get('erreur')
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
  // The password form stays until the server says Infomaniak replaced it.
  const passwordForm = methods.data?.password !== false
  const infomaniak = methods.data?.infomaniak === true

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
        {refusal && (
          <p className="login-card__message login-card__message--error" role="alert">
            <AlertIcon size={18} />
            {SIGN_IN_REFUSALS[refusal] ?? 'Connexion impossible : recommencez.'}
          </p>
        )}
        {infomaniak && (
          <a className="btn btn--primary btn--md login-card__infomaniak" href="/api/auth/infomaniak">
            <KeyIcon size={18} />
            Se connecter avec Infomaniak
          </a>
        )}
        {login.isError && (
          <p className="login-card__message login-card__message--error" role="alert">
            <AlertIcon size={18} />
            {loginErrorMessage(login.error)}
          </p>
        )}
        {passwordForm && (
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
        )}
        {passwordForm && (
          <p className="login-card__alt">
            Pas encore de compte ? <Link to="/inscription">Créer un compte</Link>
          </p>
        )}
      </main>
    </div>
  )
}
