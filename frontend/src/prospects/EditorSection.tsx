import type { ReactNode } from 'react'

import { StatusBadge } from '../ui/Badge'
import type { StateLabel } from './verification'
import './editor-section.css'

interface EditorSectionProps {
  title: string
  // Short state shown next to the title (e.g. « 1 à vérifier »), glyph + text.
  state?: StateLabel | null
  count?: number
  // Extra style of the whole section (`warning` for values to verify, `danger` for an opposition).
  tone?: 'warning' | 'danger'
  // A sub-block of another section (a smaller heading, no card of its own).
  nested?: boolean
  children: ReactNode
}

// One named region of the Prospect editor (also the panels of the Contact workbench).
export function EditorSection({ title, state, count, tone, nested, children }: EditorSectionProps) {
  const Heading = nested ? 'h4' : 'h3'
  return (
    <section className={nested ? 'prospect-editor__subsection' : 'prospect-editor__section'} data-tone={tone} aria-label={title}>
      <div className="prospect-editor__section-head">
        <Heading className="prospect-editor__section-title">
          {title}
          {count !== undefined && <span className="prospect-editor__count">{count}</span>}
        </Heading>
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
