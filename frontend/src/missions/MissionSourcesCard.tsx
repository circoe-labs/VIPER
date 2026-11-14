import { useEffect, useRef, useState } from 'react'

import { type MissionDetail, useUpdateMissionSources } from '../api/missions'
import { Badge } from '../ui/Badge'
import { Button, IconButton } from '../ui/Button'
import { Modal } from '../ui/Dialog'
import { CloseIcon, LinkIcon, LockIcon, PencilIcon, PlusIcon, TrashIcon, UndoIcon } from '../ui/icons'
import { InfoTip } from '../ui/InfoTip'
import { LibraryPicker, ManualSourcePicker } from './AddSourceDialogs'
import { MissionPanel } from './MissionPanel'
import { refusalMessage, sameIds, type SourceRef, toRef } from './sourcesDraft'
import { sourceName } from './sourceTree'
import './missionSources.css'

type Picker = 'library' | 'manual' | null
type Confirm = 'clear' | 'discard' | null

function failureText(error: unknown): string {
  return refusalMessage(error, 'Les sources n’ont pas pu être enregistrées. Réessayez.')
}

// « Sources » card of the mission page: the external sites the agent researches. Read-only by default (the
// category's defaults until the mission has its own list); « Modifier » switches to an editor that works on a draft and
// saves it once (PATCH `source_ids`). Three states are kept apart: following the category (null), a list of its own,
// and an own list that is empty (no source at all).
export function MissionSourcesCard({ mission }: { mission: MissionDetail }) {
  const save = useUpdateMissionSources(mission.card.id)
  const inherited = mission.inheritance?.sources_inherited ?? false
  const categoryId = mission.inheritance?.category_id ?? null
  const categoryRefs: SourceRef[] = (mission.inheritance?.category_sources ?? []).map((source) => ({
    ...source,
    parent_id: null,
  }))
  const categoryIds = new Set(categoryRefs.map((source) => source.id))
  const closed = mission.card.status === 'done' || mission.card.status === 'cancelled'

  const [editing, setEditing] = useState(false)
  const [follow, setFollow] = useState(inherited)
  const [items, setItems] = useState<SourceRef[]>([])
  const [picker, setPicker] = useState<Picker>(null)
  const [confirm, setConfirm] = useState<Confirm>(null)
  const clearBackRef = useRef<HTMLButtonElement>(null)

  const savedRefs = mission.sources.map(toRef)
  const dirty = editing && (follow !== inherited || (!follow && !sameIds(items.map((i) => i.id), savedRefs.map((i) => i.id))))

  // A closed tab or a reload would lose the draft.
  useEffect(() => {
    if (!dirty) return
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault()
    }
    window.addEventListener('beforeunload', warn)
    return () => {
      window.removeEventListener('beforeunload', warn)
    }
  }, [dirty])

  const startEditing = () => {
    save.reset()
    setFollow(inherited)
    setItems(savedRefs)
    setEditing(true)
  }
  const stopEditing = () => {
    save.reset()
    setPicker(null)
    setConfirm(null)
    setEditing(false)
  }
  const cancel = () => {
    if (dirty) setConfirm('discard')
    else stopEditing()
  }

  // Editing a list that follows the category first makes it the mission's own (the category's sources are already the
  // draft's items), so the first change is simply applied to it.
  const change = (next: SourceRef[]) => {
    setFollow(false)
    setItems(next)
  }
  const remove = (id: string) => {
    change(items.filter((item) => item.id !== id))
  }
  const addAll = (added: SourceRef[]) => {
    const seen = new Set(items.map((item) => item.id))
    change([...items, ...added.filter((item) => !seen.has(item.id))])
  }
  const revert = () => {
    setFollow(true)
    setItems(categoryRefs)
  }

  const commit = (ids: string[] | null) => {
    save.mutate(ids, { onSuccess: stopEditing })
  }

  const shown = editing ? items : savedRefs
  const own = editing ? !follow : !inherited
  const empty = shown.length === 0

  const emptyState = (
    <p className="msrc-empty">
      <strong>Aucune source</strong>
      <InfoTip label="Aide : aucune source">
        {own
          ? 'Cette mission n’utilise aucune source : l’agent cherche sans site imposé. « Modifier » permet d’en ajouter ou de revenir à celles de la catégorie.'
          : 'La catégorie n’a pas de source par défaut. « Modifier » permet d’en ajouter à cette mission.'}
      </InfoTip>
    </p>
  )

  const actions = editing ? (
    <>
      {dirty && <span className="msrc-dirty">Modifications non enregistrées</span>}
      <Button size="sm" disabled={save.isPending} onClick={cancel}>
        Annuler
      </Button>
      <Button
        size="sm"
        variant="primary"
        loading={save.isPending}
        disabled={!dirty}
        onClick={() => {
          commit(follow ? null : items.map((item) => item.id))
        }}
      >
        Enregistrer
      </Button>
    </>
  ) : closed ? (
    <>
      <InfoTip label="Aide : mission clôturée" icon={LockIcon}>
        Mission clôturée : ses sources ne peuvent plus être modifiées.
      </InfoTip>
      <Button size="sm" icon={PencilIcon} disabled aria-label="Modifier les sources">
        Modifier
      </Button>
    </>
  ) : (
    <Button size="sm" icon={PencilIcon} aria-label="Modifier les sources" onClick={startEditing}>
      Modifier
    </Button>
  )

  return (
    <MissionPanel title={`Sources (${String(shown.length)})`} icon={LinkIcon} hue="blue" level={2} actions={actions}>
      <div className="msrc-state">
        {own ? (
          <Badge tone="accent">Personnalisé</Badge>
        ) : (
          <>
            <Badge>Hérité</Badge>
            <InfoTip label="Aide : hérité">
              {mission.card.category?.name
                ? `Suit les sources de la catégorie « ${mission.card.category.name} ».`
                : 'Suit les sources de la catégorie.'}
            </InfoTip>
          </>
        )}
      </div>

      {empty ? (
        emptyState
      ) : (
        <ul className="mission-sources msrc-list" aria-label="Sources de la mission">
          {shown.map((source) => (
            <li key={source.id} className="mission-source msrc-row">
              <span className="msrc-row__text">
                <a href={source.url} target="_blank" rel="noreferrer noopener">
                  {sourceName(source)}
                </a>
                {source.label && <span className="mission-source__url">{source.url}</span>}
              </span>
              {categoryIds.has(source.id) && <Badge>hérité de la catégorie</Badge>}
              {editing && (
                <IconButton
                  size="sm"
                  icon={CloseIcon}
                  label={`Retirer ${sourceName(source)}`}
                  disabled={save.isPending}
                  onClick={() => {
                    remove(source.id)
                  }}
                />
              )}
            </li>
          ))}
        </ul>
      )}

      {editing && (
        <div className="msrc-tools">
          <Button
            size="sm"
            icon={PlusIcon}
            disabled={save.isPending}
            onClick={() => {
              setPicker('library')
            }}
          >
            Ajouter depuis la bibliothèque
          </Button>
          <Button
            size="sm"
            icon={PlusIcon}
            disabled={save.isPending}
            onClick={() => {
              setPicker('manual')
            }}
          >
            Ajouter manuellement
          </Button>
          <span className="msrc-tools__far">
            {!follow && categoryId !== null && (
              <Button size="sm" variant="ghost" icon={UndoIcon} disabled={save.isPending} onClick={revert}>
                Revenir aux sources de la catégorie
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              icon={TrashIcon}
              disabled={save.isPending || (items.length === 0 && !follow)}
              onClick={() => {
                setConfirm('clear')
              }}
            >
              Tout retirer
            </Button>
          </span>
        </div>
      )}

      {save.isError && confirm === null && (
        <p className="missions-error" role="alert">
          {failureText(save.error)}
        </p>
      )}

      {picker === 'library' && (
        <LibraryPicker
          taken={new Set(items.map((item) => item.id))}
          onAdd={addAll}
          onClose={() => {
            setPicker(null)
          }}
        />
      )}
      {picker === 'manual' && (
        <ManualSourcePicker
          current={items}
          onAdd={(source) => {
            addAll([source])
          }}
          onClose={() => {
            setPicker(null)
          }}
        />
      )}

      <Modal
        open={confirm === 'clear'}
        size="sm"
        title="Retirer toutes les sources ?"
        initialFocusRef={clearBackRef}
        onClose={() => {
          save.reset()
          setConfirm(null)
        }}
        footer={
          <>
            <Button
              ref={clearBackRef}
              disabled={save.isPending}
              onClick={() => {
                save.reset()
                setConfirm(null)
              }}
            >
              Retour
            </Button>
            <Button
              variant="danger"
              icon={TrashIcon}
              loading={save.isPending}
              onClick={() => {
                commit([])
              }}
            >
              Tout retirer
            </Button>
          </>
        }
      >
        <p>
          La mission n’aura plus aucune source.{' '}
          <InfoTip label="Aide : tout retirer">
            Enregistré tout de suite, sans toucher à la bibliothèque. « Revenir aux sources de la catégorie » les rétablit.
          </InfoTip>
        </p>
        {save.isError && (
          <p className="missions-error" role="alert">
            {failureText(save.error)}
          </p>
        )}
      </Modal>

      <Modal
        open={confirm === 'discard'}
        size="sm"
        title="Abandonner les modifications ?"
        onClose={() => {
          setConfirm(null)
        }}
        footer={
          <>
            <Button
              onClick={() => {
                setConfirm(null)
              }}
            >
              Continuer à modifier
            </Button>
            <Button variant="danger" onClick={stopEditing}>
              Abandonner
            </Button>
          </>
        }
      >
        <p>Les changements de sources non enregistrés seront perdus.</p>
      </Modal>
    </MissionPanel>
  )
}
