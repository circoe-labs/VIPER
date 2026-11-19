import './avatar.css'

// « Etienne Debazelaire » -> « ED »; one word -> one letter.
export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join('')
}

interface AvatarProps {
  // The person's display name: the initials are drawn from it.
  name: string
  // A blue pulsing ring: someone (an agent acting for this person) is working right now.
  working?: boolean
  size?: 'sm' | 'xs'
}

// The initials disc of a person, as in the header user menu (the account has no picture field).
export function Avatar({ name, working = false, size = 'sm' }: AvatarProps) {
  return (
    <span className={`avatar avatar--${size}${working ? ' avatar--working' : ''}`} aria-hidden="true">
      {initials(name)}
    </span>
  )
}
