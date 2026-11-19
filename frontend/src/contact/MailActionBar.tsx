import { type ReactNode, useRef, useState } from 'react'

import { Button, IconButton } from '../ui/Button'
import {
  CalendarIcon,
  CheckCircleIcon,
  CheckIcon,
  CloseIcon,
  MoreIcon,
  RefreshIcon,
  SaveIcon,
  SlidersIcon,
  SparklesIcon,
  TrashIcon,
  UndoIcon,
} from '../ui/icons'
import { Menu, type MenuItem } from '../ui/Menu'
import type { AiAvailability } from './aiDraftModel'
import type { MailActions } from './mailModel'

export interface ActionBarProps {
  ai: AiAvailability
  generating: boolean
  onGenerate: () => void
  advancedOpen: boolean
  advancedCustom: boolean
  onAdvanced: () => void
  actions: MailActions
  status: string | null
  removeLabel: string
  dirty: boolean
  busy: boolean
  saving: boolean
  hasLocalErrors: boolean
  // « Enregistrez d'abord les modifications. », the tooltip of what waits for a save.
  waitSave: string | undefined
  // A send moment is typed: the validation also schedules.
  withDate: boolean
  scheduleOpen: boolean
  unscheduling: boolean
  reopening: boolean
  // « Remettre en Validé » opens later (the Toolbox may still be sending): why it is off.
  releaseLocked: string | null
  onDiscard: () => void
  onSave: () => void
  onSaveValidate: () => void
  onValidate: () => void
  onToggleSchedule: (anchor: HTMLElement) => void
  onUnschedule: () => void
  onReopen: () => void
  onCancel: () => void
  onRemove: () => void
  onMarkSent: () => void
  onRelease: () => void
  // The workbench's « Précédent » / « Suivant », on the same row.
  navigation?: ReactNode
}

// The one action row under the mail: the AI on the left, the step's actions on the right (the primary one is the only
// prominent button), the rarely used or destructive ones behind « … », then the walk through the list.
export function MailActionBar(props: ActionBarProps) {
  const { ai, actions, status, dirty, busy } = props
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  // An outside press closes the menu before the click on « … » arrives: that click must not reopen it.
  const closedAt = useRef(0)
  const overflow: MenuItem[] = [
    ...(actions.cancel
      ? [{ id: 'cancel', label: 'Annuler le message…', icon: CloseIcon, danger: true, disabled: busy, onSelect: props.onCancel }]
      : []),
    ...(actions.remove
      ? [{ id: 'remove', label: `${props.removeLabel}…`, icon: TrashIcon, danger: true, disabled: busy, onSelect: props.onRemove }]
      : []),
  ]
  const primaryOnSave = dirty || actions.save === 'create'
  const saveValidate = dirty && actions.save === 'save' && (status === 'draft' || status === 'validated')

  return (
    <div className="mail-bar" role="toolbar" aria-label="Actions du message" data-dirty={dirty ? '' : undefined}>
      <div className="mail-bar__group">
        {ai.show && (
          <Button
            size="sm"
            icon={SparklesIcon}
            loading={props.generating}
            disabled={!ai.enabled}
            aria-label={ai.label}
            title={ai.note ?? ai.label}
            onClick={props.onGenerate}
          >
            <span className="mail-bar__label">{ai.label.startsWith('Rég') ? 'Régénérer' : 'Générer'}</span>
          </Button>
        )}
        {ai.show && (
          <Button
            size="sm"
            variant="ghost"
            icon={SlidersIcon}
            className={props.advancedCustom ? 'mail-bar__advanced mail-bar__advanced--custom' : 'mail-bar__advanced'}
            aria-haspopup="dialog"
            aria-expanded={props.advancedOpen}
            aria-label="Paramètres avancés"
            title="Paramètres avancés : consignes, ton, expéditeur, humanizer"
            onClick={props.onAdvanced}
          >
            <span className="mail-bar__label">Paramètres avancés</span>
          </Button>
        )}
        {dirty && (
          <IconButton size="sm" icon={UndoIcon} label="Abandonner les modifications" disabled={busy} onClick={props.onDiscard} />
        )}
      </div>

      <div className="mail-bar__group mail-bar__group--end">
        {actions.settle && (
          <>
            <Button size="sm" variant="primary" icon={CheckCircleIcon} disabled={busy} onClick={props.onMarkSent}>
              Marquer envoyé…
            </Button>
            <Button
              size="sm"
              icon={UndoIcon}
              disabled={busy || props.releaseLocked !== null}
              title={props.releaseLocked ?? undefined}
              onClick={props.onRelease}
            >
              Remettre en Validé…
            </Button>
          </>
        )}
        {actions.unschedule && (
          <Button
            size="sm"
            icon={UndoIcon}
            loading={props.unscheduling}
            disabled={busy || dirty}
            title={props.waitSave}
            onClick={props.onUnschedule}
          >
            Déprogrammer
          </Button>
        )}
        {actions.reopen && (
          <Button size="sm" variant="primary" icon={RefreshIcon} loading={props.reopening} disabled={busy} onClick={props.onReopen}>
            Rouvrir
          </Button>
        )}
        {actions.save && (
          <Button
            size="sm"
            variant={primaryOnSave && !saveValidate ? 'primary' : 'secondary'}
            icon={SaveIcon}
            loading={props.saving}
            aria-label={actions.save === 'create' ? 'Créer le brouillon' : 'Enregistrer'}
            disabled={(actions.save === 'save' && !dirty) || props.hasLocalErrors}
            onClick={props.onSave}
          >
            <span className={saveValidate ? 'mail-bar__label mail-bar__label--dirty' : undefined}>
              {actions.save === 'create' ? 'Créer le brouillon' : 'Enregistrer'}
            </span>
          </Button>
        )}
        {saveValidate && (
          <Button size="sm" variant="primary" icon={CheckIcon} disabled={busy || props.hasLocalErrors} onClick={props.onSaveValidate}>
            Enregistrer et valider…
          </Button>
        )}
        {actions.validate && (
          <>
            <IconButton
              size="sm"
              icon={CalendarIcon}
              label="Programmer l’envoi (facultatif)"
              className={props.withDate ? 'mail-bar__moment mail-bar__moment--set' : 'mail-bar__moment'}
              aria-haspopup="dialog"
              aria-expanded={props.scheduleOpen}
              disabled={busy}
              onClick={(event) => {
                props.onToggleSchedule(event.currentTarget)
              }}
            />
            <Button
              size="sm"
              variant={dirty ? 'secondary' : 'primary'}
              icon={props.withDate ? CalendarIcon : CheckIcon}
              aria-label={props.withDate ? 'Valider et programmer…' : 'Valider…'}
              disabled={busy || dirty}
              title={props.waitSave}
              onClick={props.onValidate}
            >
              <span className="mail-bar__label mail-bar__label--dirty">{props.withDate ? 'Valider et programmer…' : 'Valider…'}</span>
            </Button>
          </>
        )}
        {actions.schedule && (
          <Button
            size="sm"
            variant={dirty ? 'secondary' : 'primary'}
            icon={CalendarIcon}
            aria-label="Programmer…"
            aria-haspopup="dialog"
            aria-expanded={props.scheduleOpen}
            disabled={busy || dirty}
            title={props.waitSave}
            onClick={(event) => {
              props.onToggleSchedule(event.currentTarget)
            }}
          >
            <span className="mail-bar__label mail-bar__label--dirty">Programmer…</span>
          </Button>
        )}
        {overflow.length > 0 && (
          <IconButton
            size="sm"
            icon={MoreIcon}
            label="Plus d’actions"
            aria-haspopup="menu"
            aria-expanded={menu !== null}
            onClick={(event) => {
              const box = event.currentTarget.getBoundingClientRect()
              if (Date.now() - closedAt.current < 300) return
              setMenu({ x: box.right, y: box.top - 6 })
            }}
          />
        )}
        {props.navigation && <div className="mail-bar__nav">{props.navigation}</div>}
      </div>
      {menu && (
        <Menu
          label="Plus d’actions"
          position={menu}
          alignRight
          above
          sections={[{ items: overflow }]}
          onClose={() => {
            closedAt.current = Date.now()
            setMenu(null)
          }}
        />
      )}
    </div>
  )
}
