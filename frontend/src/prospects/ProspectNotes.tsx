import { type KeyboardEvent, useEffect, useRef, useState } from 'react'

import { type ProspectNote, useNoteMutations, useProspectNotes } from '../api/prospectNotes'
import { formatDay } from '../prospection/labels'
import { Button, IconButton } from '../ui/Button'
import { Modal } from '../ui/Dialog'
import { SelectField, TextAreaField, TextField } from '../ui/fields'
import type { Point } from '../ui/floating'
import { AlertIcon, MoreIcon, PencilIcon, PlusIcon, TrashIcon } from '../ui/icons'
import { Menu } from '../ui/Menu'
import { EditorSection } from './EditorSection'
import {
  draftFromNote,
  formatDelta,
  newNoteDraft,
  type NoteDraft,
  type NoteErrors,
  noteRefusalMessage,
  SOURCE_LABELS,
  toNoteInput,
  validateNote,
} from './noteForm'
import './prospect-notes.css'

interface ProspectNotesProps {
  // Null for a prospect not saved yet.
  prospectId: string | null
  // The prospect's business day: the default date of a new note.
  today: string
  // A note to show and focus (from the score detail's « Voir la note »); `onNoteShown` tells it was handled.
  showNoteId?: string | null
  onNoteShown?: () => void
}

// Notes: short facts about the prospect as a dense list (the fact first, date / source / score impact discreet, the
// actions in an overflow menu), with a one-line quick add. Notes are saved by their own API, immediately and outside
// the editor's form (they never make it dirty nor change its version). Reusable pattern: doc/design/design-system.md.
export function ProspectNotes({ prospectId, today, showNoteId = null, onNoteShown }: ProspectNotesProps) {
  return prospectId ? (
    <NotesPanel prospectId={prospectId} today={today} showNoteId={showNoteId} onNoteShown={onNoteShown} />
  ) : (
    <EditorSection title="Notes">
      <p className="prospect-editor__muted">Possible une fois le prospect enregistré.</p>
    </EditorSection>
  )
}

function NotesPanel({ prospectId, today, showNoteId, onNoteShown }: { prospectId: string; today: string; showNoteId: string | null; onNoteShown?: () => void }) {
  const notes = useProspectNotes(prospectId)
  const mutations = useNoteMutations(prospectId)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [menu, setMenu] = useState<{ note: ProspectNote; at: Point } | null>(null)
  const [deleting, setDeleting] = useState<ProspectNote | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [highlightId, setHighlightId] = useState<string | null>(null)
  const list = notes.data ?? []
  const listRef = useRef<HTMLUListElement>(null)

  // Shows a requested note: scrolled into view, highlighted and focused once the list holds it (a note that is gone,
  // or a list that failed to load, just drops the request).
  useEffect(() => {
    if (showNoteId === null || notes.isPending) return
    const row = [...(listRef.current?.querySelectorAll<HTMLElement>('[data-note-id]') ?? [])].find((item) => item.dataset.noteId === showNoteId)
    if (row) {
      setHighlightId(showNoteId)
      row.scrollIntoView({ block: 'nearest' })
      row.focus()
    }
    onNoteShown?.()
  }, [showNoteId, notes.isPending, notes.data, onNoteShown])

  async function remove(note: ProspectNote) {
    setDeleteError(null)
    try {
      await mutations.remove.mutateAsync(note.id)
      setDeleting(null)
    } catch (error) {
      // Shown in the dialog, which stays open: nothing was deleted.
      setDeleteError(noteRefusalMessage(error))
    }
  }

  return (
    <EditorSection title="Notes" count={notes.data ? list.length : undefined}>
      <QuickAdd prospectId={prospectId} today={today} />
      {notes.isPending && <p className="prospect-editor__muted">Chargement des notes…</p>}
      {notes.isError && (
        <div className="prospect-notes__error" role="alert">
          <AlertIcon size={16} />
          Les notes n’ont pas pu être chargées.
          <Button
            size="sm"
            onClick={() => {
              void notes.refetch()
            }}
          >
            Réessayer
          </Button>
        </div>
      )}
      {notes.data && list.length === 0 && <p className="prospect-editor__muted">Aucune note pour l’instant.</p>}
      {list.length > 0 && (
        // Bounded height: a long list scrolls inside the section instead of pushing the rest of the column away.
        <ul ref={listRef} className="prospect-notes" aria-label="Liste des notes" tabIndex={0}>
          {list.map((note) => (
            <li
              key={note.id}
              className="prospect-note"
              data-note-id={note.id}
              data-editing={note.id === editingId ? '' : undefined}
              data-highlight={note.id === highlightId ? '' : undefined}
              tabIndex={-1}
              onBlur={() => {
                if (note.id === highlightId) setHighlightId(null)
              }}
            >
              {note.id === editingId ? (
                <NoteEditor
                  prospectId={prospectId}
                  note={note}
                  onDone={() => {
                    setEditingId(null)
                  }}
                />
              ) : (
                <NoteRow
                  note={note}
                  onMenu={(at) => {
                    setMenu({ note, at })
                  }}
                />
              )}
            </li>
          ))}
        </ul>
      )}
      {menu && (
        <Menu
          label="Actions sur la note"
          position={menu.at}
          alignRight
          sections={[
            {
              items: [
                {
                  id: 'edit',
                  label: 'Modifier',
                  icon: PencilIcon,
                  onSelect: () => {
                    setEditingId(menu.note.id)
                  },
                },
                {
                  id: 'delete',
                  label: 'Supprimer',
                  icon: TrashIcon,
                  danger: true,
                  onSelect: () => {
                    setDeleteError(null)
                    setDeleting(menu.note)
                  },
                },
              ],
            },
          ]}
          onClose={() => {
            setMenu(null)
          }}
        />
      )}
      {deleting && (
        <DeleteNoteDialog
          note={deleting}
          busy={mutations.remove.isPending}
          error={deleteError}
          onConfirm={() => void remove(deleting)}
          onClose={() => {
            setDeleting(null)
            setDeleteError(null)
          }}
        />
      )}
    </EditorSection>
  )
}

// Plain Enter adds the note: it must never reach the editor's form (that would save the prospect and move on).
// Ctrl/⌘+Enter with a typed fact adds the note too, so « Enregistrer et suivant » cannot silently drop it.
function enterSubmits(event: KeyboardEvent, hasFact: boolean, submit: () => void) {
  if (event.key !== 'Enter' || event.nativeEvent.isComposing) return
  if ((event.ctrlKey || event.metaKey) && !hasFact) return
  event.preventDefault()
  event.stopPropagation()
  submit()
}

function QuickAdd({ prospectId, today }: { prospectId: string; today: string }) {
  const { create } = useNoteMutations(prospectId)
  const [draft, setDraft] = useState<NoteDraft>(() => newNoteDraft(today))
  const [deltaOpen, setDeltaOpen] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const factRef = useRef<HTMLInputElement>(null)
  const errors = submitted ? validateNote(draft) : {}
  const hasFact = draft.fact.trim() !== ''

  function change(patch: Partial<NoteDraft>) {
    setDraft((current) => ({ ...current, ...patch }))
    setFailure(null)
  }

  async function submit() {
    if (create.isPending) return
    setSubmitted(true)
    const invalid = validateNote(draft)
    if (invalid.fact) {
      factRef.current?.focus()
      return
    }
    if (invalid.delta) return
    try {
      await create.mutateAsync(toNoteInput(draft))
      setDraft(newNoteDraft(today))
      setDeltaOpen(false)
      setSubmitted(false)
      setFailure(null)
      factRef.current?.focus()
    } catch (error) {
      setFailure(noteRefusalMessage(error))
    }
  }

  const onKeyDown = (event: KeyboardEvent) => {
    enterSubmits(event, hasFact, () => void submit())
  }

  return (
    <div className="prospect-notes__add">
      <div className="prospect-notes__add-line">
        <TextField
          ref={factRef}
          label="Nouveau fait"
          placeholder="Ajouter un fait…"
          value={draft.fact}
          error={errors.fact}
          onChange={(event) => {
            change({ fact: event.target.value })
          }}
          onKeyDown={onKeyDown}
        />
        <Button icon={PlusIcon} loading={create.isPending} onClick={() => void submit()}>
          Ajouter
        </Button>
      </div>
      <div className="prospect-notes__add-options">
        <TextField
          label="Date du fait"
          type="date"
          value={draft.day}
          onChange={(event) => {
            change({ day: event.target.value })
          }}
          onKeyDown={onKeyDown}
        />
        {deltaOpen ? (
          <TextField
            label="Impact sur le score"
            inputMode="numeric"
            placeholder="+5 ou -10"
            value={draft.delta}
            error={errors.delta}
            onChange={(event) => {
              change({ delta: event.target.value })
            }}
            onKeyDown={onKeyDown}
          />
        ) : (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setDeltaOpen(true)
            }}
          >
            Impact sur le score…
          </Button>
        )}
      </div>
      {failure && (
        <p className="prospect-notes__error" role="alert">
          <AlertIcon size={16} />
          {failure}
        </p>
      )}
    </div>
  )
}

function NoteRow({ note, onMenu }: { note: ProspectNote; onMenu: (at: Point) => void }) {
  const meta = [
    note.noted_on ? formatDay(note.noted_on) : null,
    note.source_type ? SOURCE_LABELS[note.source_type] : null,
    note.source_label,
  ].filter(Boolean)
  const short = note.fact_text.length > 40 ? `${note.fact_text.slice(0, 40)}…` : note.fact_text
  return (
    <>
      <div className="prospect-note__body">
        <p className="prospect-note__fact">{note.fact_text}</p>
        <p className="prospect-note__meta">{meta.length > 0 ? meta.join(' · ') : 'Sans date'}</p>
      </div>
      {note.score_delta !== null && (
        <span
          className="prospect-note__delta"
          data-sign={Math.sign(note.score_delta)}
          role="img"
          aria-label={`Impact sur le score : ${formatDelta(note.score_delta)}`}
          title="Impact sur le score"
        >
          {formatDelta(note.score_delta)}
        </span>
      )}
      <IconButton
        className="prospect-note__actions"
        size="sm"
        icon={MoreIcon}
        label={`Actions : ${short}`}
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect()
          onMenu({ x: rect.right, y: rect.bottom + 4 })
        }}
      />
    </>
  )
}

// In-place edit: Enter saves, Esc cancels (and only the edit: the drawer stays open).
function NoteEditor({ prospectId, note, onDone }: { prospectId: string; note: ProspectNote; onDone: () => void }) {
  const { update } = useNoteMutations(prospectId)
  const [draft, setDraft] = useState<NoteDraft>(() => draftFromNote(note))
  const [submitted, setSubmitted] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const errors: NoteErrors = submitted ? validateNote(draft) : {}

  function change(patch: Partial<NoteDraft>) {
    setDraft((current) => ({ ...current, ...patch }))
    setFailure(null)
  }

  async function save() {
    if (update.isPending) return
    setSubmitted(true)
    if (Object.keys(validateNote(draft)).length > 0) return
    try {
      await update.mutateAsync({ id: note.id, patch: toNoteInput(draft) })
      onDone()
    } catch (error) {
      setFailure(noteRefusalMessage(error))
    }
  }

  function handleKeyDown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      onDone()
    } else {
      enterSubmits(event, true, () => void save())
    }
  }

  return (
    <div className="prospect-note__edit" role="group" aria-label="Modifier la note" onKeyDown={handleKeyDown}>
      <TextAreaField
        label="Fait"
        rows={2}
        autoFocus
        value={draft.fact}
        error={errors.fact}
        onChange={(event) => {
          change({ fact: event.target.value })
        }}
      />
      <div className="prospect-note__edit-grid">
        <TextField
          label="Date"
          type="date"
          value={draft.day}
          onChange={(event) => {
            change({ day: event.target.value })
          }}
        />
        <TextField
          label="Impact sur le score"
          inputMode="numeric"
          placeholder="+5 ou -10"
          value={draft.delta}
          error={errors.delta}
          onChange={(event) => {
            change({ delta: event.target.value })
          }}
        />
        <SelectField
          label="Source"
          value={draft.source_type}
          onChange={(event) => {
            change({ source_type: event.target.value as NoteDraft['source_type'] })
          }}
        >
          <option value="">Non précisée</option>
          {Object.entries(SOURCE_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </SelectField>
        <TextField
          label="Précision de la source"
          value={draft.source_label}
          onChange={(event) => {
            change({ source_label: event.target.value })
          }}
        />
      </div>
      {failure && (
        <p className="prospect-notes__error" role="alert">
          <AlertIcon size={16} />
          {failure}
        </p>
      )}
      <div className="prospect-note__edit-actions">
        <Button size="sm" onClick={onDone} disabled={update.isPending}>
          Annuler
        </Button>
        <Button size="sm" variant="primary" loading={update.isPending} onClick={() => void save()}>
          Enregistrer la note
        </Button>
      </div>
    </div>
  )
}

interface DeleteNoteDialogProps {
  note: ProspectNote
  busy: boolean
  error: string | null
  onConfirm: () => void
  onClose: () => void
}

// « Retour » is focused first, so Enter never deletes by accident.
function DeleteNoteDialog({ note, busy, error, onConfirm, onClose }: DeleteNoteDialogProps) {
  const backRef = useRef<HTMLButtonElement>(null)
  return (
    <Modal
      open
      size="sm"
      title="Supprimer cette note ?"
      initialFocusRef={backRef}
      onClose={onClose}
      footer={
        <>
          <Button ref={backRef} disabled={busy} onClick={onClose}>
            Retour
          </Button>
          <Button variant="danger" loading={busy} onClick={onConfirm}>
            Supprimer la note
          </Button>
        </>
      }
    >
      <div className="prospect-editor__dialog">
        <p className="prospect-note__quote">{note.fact_text}</p>
        {note.score_delta !== null && <p>Son impact sur le score ({formatDelta(note.score_delta)}) disparaîtra avec elle.</p>}
        <p className="prospect-editor__muted">La suppression est tracée dans l’historique.</p>
        {error && (
          <p className="prospect-notes__error" role="alert">
            <AlertIcon size={16} />
            {error}
          </p>
        )}
      </div>
    </Modal>
  )
}
