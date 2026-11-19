import { useState } from 'react'

import { type Message, type MessageVersion, useMessageVersions } from '../api/contact'
import { Button, IconButton } from '../ui/Button'
import { Modal } from '../ui/Dialog'
import { AlertIcon, ColumnsIcon, HistoryIcon, PencilIcon, SparklesIcon, UndoIcon } from '../ui/icons'
import { Popover } from '../ui/Popover'
import { formatDateTime, formatShortDateTime } from './labels'
import { configSummary } from './mailRatings'
import { diffLines, pairChanges } from './textDiff'

const SOURCES = {
  ai: { label: 'IA', icon: SparklesIcon },
  manual: { label: 'Manuel', icon: PencilIcon },
  restore: { label: 'Restauré', icon: UndoIcon },
} as const

// The text shown now (saved or being typed): what a version is compared with, and what « Actuelle » means.
export interface ShownText {
  subject: string
  body: string
}

function isCurrent(version: MessageVersion, shown: ShownText): boolean {
  return version.subject === shown.subject && version.body_text === shown.body
}

interface VersionsControlProps {
  prospectId: string
  step: string
  stepLabel: string
  message: Message | null
  shown: ShownText
  // The step can be edited (not sent / cancelled / closed): without it, versions can still be read and compared.
  canRestore: boolean
  busy: boolean
  open: boolean
  onOpenChange: (open: boolean) => void
  // « Revenir à cette version »: the editor saves what is typed, confirms for a validated message, then restores.
  onRestore: (version: MessageVersion) => void
}

// « Versions » of the step: an icon with the count in the action row, a popover listing every kept text (an AI
// generation, a manual state, a restoration — newest first). A click brings a version back as the current draft (itself
// recorded, so nothing is ever lost); the columns icon compares it with the text shown now.
export function VersionsControl({
  prospectId,
  step,
  stepLabel,
  message,
  shown,
  canRestore,
  busy,
  open,
  onOpenChange,
  onRestore,
}: VersionsControlProps) {
  const query = useMessageVersions(prospectId, step)
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null)
  const [comparing, setComparing] = useState<MessageVersion | null>(null)
  const versions = query.data?.versions ?? []
  const count = versions.length
  const label = count === 0 ? 'Versions du message : aucune pour l’instant' : `Versions du message : ${String(count)}`
  return (
    <>
      <Button
        ref={setAnchor}
        size="sm"
        variant="ghost"
        icon={HistoryIcon}
        className="mail-bar__versions"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={label}
        title={label}
        onClick={() => {
          onOpenChange(!open)
        }}
      >
        {count > 0 && <span className="mail-bar__count">{count}</span>}
      </Button>
      {open && anchor && (
        <Popover
          anchor={anchor}
          label={`Versions du message ${stepLabel}`}
          alignRight
          above
          className="mail-popover mail-popover--wide mail-versions"
          onClose={() => {
            onOpenChange(false)
          }}
        >
          <div className="mail-versions__head">
            <strong>Versions · {stepLabel}</strong>
            <span className="mail-popover__meta">{count}</span>
          </div>
          {query.isError && (
            <p className="mail-versions__empty" role="alert">
              <AlertIcon size={16} /> Versions indisponibles.
            </p>
          )}
          {!query.isError && count === 0 && (
            <p className="mail-versions__empty">Chaque génération IA et chaque modification sera conservée ici.</p>
          )}
          <ul className="mail-versions__list">
            {versions.map((version) => {
              const current = isCurrent(version, shown)
              const source = SOURCES[version.source]
              const Icon = source.icon
              const config = configSummary(version.config)
              const title = `${source.label} · ${formatDateTime(version.created_at)}${config ? ` · ${config}` : ''}`
              return (
                <li key={version.id} className="mail-versions__item" data-current={current ? '' : undefined}>
                  <button
                    type="button"
                    className="mail-versions__pick"
                    disabled={!canRestore || busy || current}
                    title={current ? 'Version actuelle' : canRestore ? `Revenir à cette version (${title})` : title}
                    onClick={() => {
                      onRestore(version)
                    }}
                  >
                    <span className={`mail-versions__source mail-versions__source--${version.source}`}>
                      <Icon size={14} />
                      {source.label}
                    </span>
                    <span className="mail-versions__text">
                      <span className="mail-versions__subject">{version.subject.trim() || 'Sans objet'}</span>
                      <span className="mail-versions__meta">
                        {formatShortDateTime(version.created_at)}
                        {config ? ` · ${config}` : ''}
                        {version.saved_at && version.rating !== null ? ` · sauvegardé ${String(version.rating)}/10` : ''}
                      </span>
                    </span>
                    {current && <span className="mail-versions__now">Actuelle</span>}
                  </button>
                  <IconButton
                    size="sm"
                    icon={ColumnsIcon}
                    label="Comparer avec le texte actuel"
                    disabled={current}
                    onClick={() => {
                      setComparing(version)
                      onOpenChange(false)
                    }}
                  />
                </li>
              )
            })}
          </ul>
        </Popover>
      )}
      {comparing && (
        <CompareDialog
          version={comparing}
          shown={shown}
          message={message}
          canRestore={canRestore && !busy}
          onRestore={() => {
            onRestore(comparing)
            setComparing(null)
          }}
          onClose={() => {
            setComparing(null)
          }}
        />
      )}
    </>
  )
}

interface DiffLine {
  kind: 'same' | 'changed' | 'blank'
  text: string
}

function CompareColumn({
  title,
  subject,
  changed,
  lines,
  side,
}: {
  title: string
  subject: string
  changed: boolean
  lines: DiffLine[]
  side: 'before' | 'after'
}) {
  return (
    <section className={`mail-compare__col mail-compare__col--${side}`} aria-label={title}>
      <h3 className="mail-compare__title">{title}</h3>
      <p className="mail-compare__subject" data-changed={changed ? '' : undefined}>
        <span className="mail-compare__key">Objet</span> {subject || '—'}
      </p>
      <div className="mail-compare__body">
        {lines.map((line, index) => (
          <p key={index} className={`mail-compare__line mail-compare__line--${line.kind}`}>
            {line.text === '' ? ' ' : line.text}
          </p>
        ))}
      </div>
    </section>
  )
}

function columns(before: string, after: string): { before: DiffLine[]; after: DiffLine[]; tooLong: boolean } {
  const rows = diffLines(before, after)
  if (rows === null) {
    const plain = (text: string): DiffLine[] => text.split('\n').map((line) => ({ kind: 'same', text: line }))
    return { before: plain(before), after: plain(after), tooLong: true }
  }
  const left: DiffLine[] = []
  const right: DiffLine[] = []
  for (const row of pairChanges(rows)) {
    const changed = row.kind !== 'same'
    left.push(row.before === null ? { kind: 'blank', text: '' } : { kind: changed ? 'changed' : 'same', text: row.before })
    right.push(row.after === null ? { kind: 'blank', text: '' } : { kind: changed ? 'changed' : 'same', text: row.after })
  }
  return { before: left, after: right, tooLong: false }
}

// « Comparer »: the chosen version (left) and the text shown now (right), line by line; the lines that differ are
// highlighted. It changes nothing by itself: « Restaurer cette version » brings the left text back as the draft.
function CompareDialog({
  version,
  shown,
  message,
  canRestore,
  onRestore,
  onClose,
}: {
  version: MessageVersion
  shown: ShownText
  message: Message | null
  canRestore: boolean
  onRestore: () => void
  onClose: () => void
}) {
  const split = columns(version.body_text, shown.body)
  const subjectChanged = version.subject !== shown.subject
  const source = SOURCES[version.source].label
  const config = configSummary(version.config)
  return (
    <Modal
      open
      size="xl"
      title={`Comparer les versions · ${version.step_label}`}
      className="mail-compare"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Fermer</Button>
          {canRestore && message && (
            <Button variant="primary" icon={UndoIcon} onClick={onRestore}>
              Restaurer cette version
            </Button>
          )}
        </>
      }
    >
      <div className="mail-compare__grid">
        <CompareColumn
          side="before"
          title={`${source} du ${formatDateTime(version.created_at)}${config ? ` · ${config}` : ''}`}
          subject={version.subject}
          changed={subjectChanged}
          lines={split.before}
        />
        <CompareColumn side="after" title="Texte actuel" subject={shown.subject} changed={subjectChanged} lines={split.after} />
      </div>
      {split.tooLong && <p className="mail-versions__empty">Textes trop longs pour surligner les différences.</p>}
    </Modal>
  )
}
