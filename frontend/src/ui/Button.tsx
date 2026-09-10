import type { ComponentProps } from 'react'

import { type IconComponent, SpinnerIcon } from './icons'
import './button.css'

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'
export type ButtonSize = 'sm' | 'md'

interface CommonProps {
  variant?: ButtonVariant
  size?: ButtonSize
  loading?: boolean
}

export type ButtonProps = ComponentProps<'button'> & CommonProps & { icon?: IconComponent }

function classes(base: string, variant: ButtonVariant, size: ButtonSize, className?: string) {
  return [base, `btn--${variant}`, `btn--${size}`, className].filter(Boolean).join(' ')
}

// `type` defaults to "button" so a Button never submits a form by accident; pass type="submit" explicitly.
export function Button({
  variant = 'secondary',
  size = 'md',
  loading = false,
  icon: Icon,
  disabled,
  className,
  children,
  type = 'button',
  ...props
}: ButtonProps) {
  const LeadingIcon = loading ? SpinnerIcon : Icon
  return (
    <button
      type={type}
      className={classes('btn', variant, size, className)}
      disabled={Boolean(disabled) || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {LeadingIcon && <LeadingIcon size={size === 'sm' ? 16 : 18} className={loading ? 'btn__spinner' : undefined} />}
      {children}
    </button>
  )
}

export type IconButtonProps = Omit<ComponentProps<'button'>, 'children' | 'aria-label'> &
  CommonProps & { icon: IconComponent; label: string }

// Icon-only button: `label` is mandatory and becomes both the accessible name and the hover tooltip.
export function IconButton({
  variant = 'ghost',
  size = 'md',
  loading = false,
  icon: Icon,
  label,
  disabled,
  className,
  type = 'button',
  ...props
}: IconButtonProps) {
  const Glyph = loading ? SpinnerIcon : Icon
  return (
    <button
      type={type}
      className={classes('btn btn--icon', variant, size, className)}
      aria-label={label}
      title={label}
      disabled={Boolean(disabled) || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      <Glyph size={size === 'sm' ? 16 : 20} className={loading ? 'btn__spinner' : undefined} />
    </button>
  )
}
