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
  // Optional leading glyph (e.g. the calendar of a week tag); decorative, the text carries the meaning.
  icon?: IconComponent
  // Tooltip with the full reading (e.g. the week's year and Monday).
  title?: string
  children: ReactNode
}

// Plain label/tag (counts, categories, the next-action week) carrying no status meaning.
export function Badge({ tone = 'neutral', icon: Icon, title, children }: BadgeProps) {
  return (
    <span className={`badge badge--tag badge--tag-${tone}`} title={title}>
      {Icon && <Icon size={14} />}
      {children}
    </span>
  )
}
