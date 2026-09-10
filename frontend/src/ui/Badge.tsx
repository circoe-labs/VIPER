import type { ReactNode } from 'react'

import {
  AlertIcon,
  BanIcon,
  CheckCircleIcon,
  type IconComponent,
  InfoIcon,
  MinusCircleIcon,
} from './icons'
import './badge.css'

export type StatusTone = 'success' | 'warning' | 'danger' | 'info' | 'neutral'

// Default glyph per tone, so a status is always shape + text, never colour alone.
const TONE_ICONS: Record<StatusTone, IconComponent> = {
  success: CheckCircleIcon,
  warning: AlertIcon,
  danger: BanIcon,
  info: InfoIcon,
  neutral: MinusCircleIcon,
}

interface StatusBadgeProps {
  tone: StatusTone
  children: ReactNode
  icon?: IconComponent
}

// Status indicator (verified, unverified, stale, do-not-contact…). Tones: success = positive/verified (a mint that
// is deliberately NOT brand green), warning = verification needed, danger = destructive/do-not-contact.
export function StatusBadge({ tone, children, icon }: StatusBadgeProps) {
  const Icon = icon ?? TONE_ICONS[tone]
  return (
    <span className={`badge badge--${tone}`}>
      <Icon size={14} />
      {children}
    </span>
  )
}

interface BadgeProps {
  tone?: 'neutral' | 'accent'
  children: ReactNode
}

// Plain label/tag (counts, categories) carrying no status meaning.
export function Badge({ tone = 'neutral', children }: BadgeProps) {
  return <span className={`badge badge--tag badge--tag-${tone}`}>{children}</span>
}
