import type { ReactNode } from 'react'

import { StatusBadge } from '../ui/Badge'
import type { StateLabel } from './verification'

interface EditorSectionProps {
  title: string
  // Short state shown next to the title (e.g. « 1 à vérifier »), glyph + text.
  state?: StateLabel | null
  count?: number
  // Extra style of the whole section (`warning` for values to verify, `danger` for an opposition).
  tone?: 'warning' | 'danger'
  children: ReactNode
}

// One named region of the Prospect editor.
export function EditorSection({ title, state, count, tone, children }: EditorSectionProps) {
  return (
    <section className="prospect-editor__section" data-tone={tone} aria-label={title}>
      <div className="prospect-editor__section-head">
        <h3 className="prospect-editor__section-title">
          {title}
          {count !== undefined && <span className="prospect-editor__count">{count}</span>}
        </h3>
        {state && (
          <StatusBadge tone={state.tone} icon={state.icon}>
            {state.text}
          </StatusBadge>
        )}
      </div>
      {children}
    </section>
  )
}
