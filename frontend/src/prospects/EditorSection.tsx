import { type ReactNode, useEffect, useRef } from 'react'

import { StatusBadge } from '../ui/Badge'
import { Button } from '../ui/Button'
import { CheckIcon, PencilIcon } from '../ui/icons'
import type { StateLabel } from './verification'
import './editor-section.css'

// Read/edit switch of a section that reads as a summary until edited (Prospect editor, Profil tab). The section only
// shows inputs while `editing`; the data itself stays in the editor's one draft.
export interface SectionEdit {
  editing: boolean
  onEdit: () => void
  onDone: () => void
  // Always editing (a new prospect): no switch.
  locked?: boolean
  // « Terminer » is hidden while a field of the section is invalid: it cannot go back to a summary.
  canDone?: boolean
}

interface EditorSectionProps {
  title: string
  // Short state shown next to the title (e.g. « 1 à vérifier »), glyph + text.
  state?: StateLabel | null
  count?: number
  // Extra style of the whole section (`warning` for values to verify, `danger` for an opposition).
  tone?: 'warning' | 'danger'
  edit?: SectionEdit
  children: ReactNode
}

const FIELD = 'input:not([type="hidden"]):not([disabled]), select:not([disabled]), textarea:not([disabled])'

// One named region of the Prospect editor (also the panels of the Contact workbench).
export function EditorSection({ title, state, count, tone, edit, children }: EditorSectionProps) {
  const sectionRef = useRef<HTMLElement>(null)
  const focusField = useRef(false)
  const editing = edit?.editing ?? false

  // « Modifier » moves the focus into the section's first field once the inputs are there.
  useEffect(() => {
    if (!focusField.current || !editing) return
    focusField.current = false
    sectionRef.current?.querySelector<HTMLElement>(FIELD)?.focus()
  })

  return (
    <section ref={sectionRef} className="prospect-editor__section" data-tone={tone} aria-label={title}>
      <div className="prospect-editor__section-head">
        <h3 className="prospect-editor__section-title">
          {title}
          {count !== undefined && <span className="prospect-editor__count">{count}</span>}
        </h3>
        <div className="prospect-editor__section-tools">
          {state && (
            <StatusBadge tone={state.tone} icon={state.icon}>
              {state.text}
            </StatusBadge>
          )}
          {edit && !edit.locked && (editing ? edit.canDone !== false : true) && (
            <Button
              size="sm"
              variant={editing ? 'ghost' : 'secondary'}
              icon={editing ? CheckIcon : PencilIcon}
              aria-label={`${editing ? 'Terminer' : 'Modifier'} : ${title}`}
              data-edit-toggle=""
              onClick={() => {
                if (editing) {
                  edit.onDone()
                } else {
                  focusField.current = true
                  edit.onEdit()
                }
              }}
            >
              {editing ? 'Terminer' : 'Modifier'}
            </Button>
          )}
        </div>
      </div>
      {children}
    </section>
  )
}
