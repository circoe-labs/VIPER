import { ApiError } from '../api/client'
import { useCurrentUser } from '../auth/currentUser'
import { useLogout } from '../auth/session'
import { IconButton } from '../ui/Button'
import { AlertIcon, LogOutIcon } from '../ui/icons'

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join('')
}

// Header user zone: who is signed in, and sign-out. A 401 during sign-out is handled globally (session already gone).
export function UserMenu() {
  const user = useCurrentUser()
  const logout = useLogout()
  const failed = logout.isError && !(logout.error instanceof ApiError && logout.error.status === 401)
  return (
    <div className="user-menu">
      <span className="user-menu__avatar" aria-hidden="true">
        {initials(user.display_name)}
      </span>
      <p className="user-menu__name" title={user.email}>
        <span className="visually-hidden">Connecté : </span>
        {user.display_name}
      </p>
      {failed && (
        <p className="user-menu__error" role="alert">
          <AlertIcon size={16} />
          Déconnexion impossible
        </p>
      )}
      <IconButton
        icon={LogOutIcon}
        label="Se déconnecter"
        loading={logout.isPending}
        onClick={() => {
          logout.mutate()
        }}
      />
    </div>
  )
}
