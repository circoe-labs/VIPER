import { useState } from 'react'

import {
  useCreateSource,
  useRemoveSource,
  useSourceLibrary,
  useUpdateSource,
} from '../api/missionConfig'
import type { MissionSource } from '../api/missions'
import { buildSourceTree, sourceName, usesLabel, usesOf } from '../missions/sourceTree'
import { Badge } from '../ui/Badge'
import { Button } from '../ui/Button'
import { Modal } from '../ui/Dialog'
import { EmptyState } from '../ui/EmptyState'
import { SelectField, TextAreaField, TextField } from '../ui/fields'
import { ChevronDownIcon, ChevronRightIcon, LinkIcon, PencilIcon, PlusIcon, SaveIcon, TrashIcon } from '../ui/icons'
import { SearchField } from '../ui/SearchField'
import { ConfirmDelete, ErrorNote, plural, QueryState } from './adminShared'

type Editing = { source: MissionSource | null; parentId: string | null }

// Administration › Sources: the library of external research sources. A root (LinkedIn) can have sub-sources
// (LinkedIn › Jobs). The figure beside each is the number of accepted results it supported — never a visit count, never
// a relevance score.
export function SourcesAdmin() {
  const [search, setSearch] = useState('')
  const library = useSourceLibrary({ q: search.trim() || undefined, order: 'name' })
  const [editing, setEditing] = useState<Editing | null>(null)
  const [deleting, setDeleting] = useState<MissionSource | null>(null)
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set())
  const toggle = (id: string) => {
    setOpen((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  return (
    <>
      <div className="adm-toolbar">
        <SearchField label="Rechercher une source" value={search} onChange={setSearch} />
        <Button
          variant="primary"
          icon={PlusIcon}
          onClick={() => {
            setEditing({ source: null, parentId: null })
          }}
        >
          Nouvelle source
        </Button>
      </div>
      <QueryState query={library} what="Sources">
        {(rows) => {
          const tree = buildSourceTree(rows)
          if (tree.length === 0) {
            return (
              <EmptyState
                icon={LinkIcon}
                title={search.trim() ? 'Aucune source trouvée' : 'Aucune source pour l’instant'}
                description={
                  search.trim()
                    ? 'Essayez un autre mot (nom, domaine ou description).'
                    : 'Ajoutez les sites que les agents doivent consulter.'
                }
              />
            )
          }
          return (
            <ul className="adm-tree" aria-label="Bibliothèque de sources">
              {tree.map(({ source, children }) => {
                const expanded = open.has(source.id) || (search.trim() !== '' && children.length > 0)
                return (
                  <li key={source.id}>
                    <SourceRow
                      source={source}
                      childCount={children.length}
                      expanded={expanded}
                      onToggle={() => {
                        toggle(source.id)
                      }}
                      onEdit={() => {
                        setEditing({ source, parentId: source.parent_id ?? null })
                      }}
                      onDelete={() => {
                        setDeleting(source)
                      }}
                      onAddChild={() => {
                        setEditing({ source: null, parentId: source.id })
                      }}
                    />
                    {expanded && children.length > 0 && (
                      <ul className="adm-tree__children" aria-label={`Sous-sources de ${sourceName(source)}`}>
                        {children.map((child) => (
                          <li key={child.id}>
                            <SourceRow
                              source={child}
                              childCount={0}
                              expanded={false}
                              onToggle={() => undefined}
                              onEdit={() => {
                                setEditing({ source: child, parentId: child.parent_id ?? null })
                              }}
                              onDelete={() => {
                                setDeleting(child)
                              }}
                            />
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                )
              })}
            </ul>
          )
        }}
      </QueryState>
      {editing && (
        <SourceEditor
          editing={editing}
          roots={(library.data ?? []).filter((source) => !source.parent_id)}
          onClose={() => {
            setEditing(null)
          }}
        />
      )}
      {deleting && (
        <DeleteSource
          source={deleting}
          onClose={() => {
            setDeleting(null)
          }}
        />
      )}
    </>
  )
}

function SourceRow({
  source,
  childCount,
  expanded,
  onToggle,
  onEdit,
  onDelete,
  onAddChild,
}: {
  source: MissionSource
  childCount: number
  expanded: boolean
  onToggle: () => void
  onEdit: () => void
  onDelete: () => void
  onAddChild?: () => void
}) {
  const name = sourceName(source)
  return (
    <div className="adm-tree__row">
      {onAddChild &&
        (childCount > 0 ? (
          <Button
            size="sm"
            variant="ghost"
            aria-expanded={expanded}
            aria-label={`${expanded ? 'Replier' : 'Déplier'} les sous-sources de ${name}`}
            icon={expanded ? ChevronDownIcon : ChevronRightIcon}
            onClick={onToggle}
          />
        ) : null)}
      <div className="adm-tree__main">
        <p className="adm-tree__name">{name}</p>
        <p className="adm-tree__meta">
          {[source.label ? source.url : '', source.description ?? ''].filter(Boolean).join(' · ')}
        </p>
      </div>
      <div className="adm-tree__badges">
        <Badge title="Résultats acceptés que cette source a appuyés (jamais de simples visites)">
          {usesLabel(usesOf(source))}
        </Badge>
        {childCount > 0 && <Badge>{plural(childCount, 'sous-source')}</Badge>}
      </div>
      <div className="adm-tree__actions">
        {onAddChild && (
          <Button size="sm" icon={PlusIcon} aria-label={`Ajouter une sous-source à ${name}`} onClick={onAddChild}>
            Sous-source
          </Button>
        )}
        <Button size="sm" icon={PencilIcon} aria-label={`Modifier la source ${name}`} onClick={onEdit}>
          Modifier
        </Button>
        <Button size="sm" variant="danger" icon={TrashIcon} aria-label={`Supprimer la source ${name}`} title="Supprimer" onClick={onDelete} />
      </div>
    </div>
  )
}

function SourceEditor({
  editing,
  roots,
  onClose,
}: {
  editing: Editing
  roots: MissionSource[]
  onClose: () => void
}) {
  const { source } = editing
  const create = useCreateSource()
  const update = useUpdateSource(source?.id ?? '')
  const saving = source ? update : create
  const [url, setUrl] = useState(source?.url ?? '')
  const [label, setLabel] = useState(source?.label ?? '')
  const [description, setDescription] = useState(source?.description ?? '')
  const [parentId, setParentId] = useState(editing.parentId ?? '')
  // One level only: a source that has sub-sources stays a root; a root candidate is never the source itself.
  const canHaveParent = !source || (source.children_count ?? 0) === 0
  const parents = roots.filter((root) => root.id !== source?.id)
  const canSave = source ? true : url.trim() !== ''
  const submit = () => {
    const common = { label: label.trim() || null, description: description.trim() || null }
    if (source) {
      update.mutate({ ...common, parent_id: parentId || null }, { onSuccess: onClose })
    } else {
      create.mutate({ ...common, url: url.trim(), parent_id: parentId || null }, { onSuccess: onClose })
    }
  }
  return (
    <Modal
      open
      size="md"
      title={source ? 'Modifier la source' : parentId ? 'Nouvelle sous-source' : 'Nouvelle source'}
      onClose={onClose}
      footer={
        <>
          <Button disabled={saving.isPending} onClick={onClose}>
            Annuler
          </Button>
          <Button variant="primary" icon={SaveIcon} loading={saving.isPending} disabled={!canSave} onClick={submit}>
            Enregistrer
          </Button>
        </>
      }
    >
      <div className="adm-form">
        <TextField
          label="Adresse"
          type="url"
          required
          disabled={source !== null}
          value={url}
          placeholder="https://…"
          hint={source ? 'L’adresse ne change pas : créez une autre source si besoin.' : 'Un chemin (…/jobs) sous un site déjà listé devient sa sous-source.'}
          onChange={(event) => {
            setUrl(event.target.value)
          }}
        />
        <TextField
          label="Nom (facultatif)"
          maxLength={200}
          value={label}
          onChange={(event) => {
            setLabel(event.target.value)
          }}
        />
        <TextAreaField
          label="Description"
          rows={3}
          maxLength={1000}
          value={description}
          hint="À quoi sert cette source, ce qu’on y trouve."
          onChange={(event) => {
            setDescription(event.target.value)
          }}
        />
        {canHaveParent && (
          <SelectField
            label="Source parente"
            value={parentId}
            onChange={(event) => {
              setParentId(event.target.value)
            }}
          >
            <option value="">Aucune (source principale)</option>
            {parents.map((root) => (
              <option key={root.id} value={root.id}>
                {sourceName(root)}
              </option>
            ))}
          </SelectField>
        )}
        <ErrorNote error={saving.error} fallback="La source n’a pas pu être enregistrée." />
      </div>
    </Modal>
  )
}

function DeleteSource({ source, onClose }: { source: MissionSource; onClose: () => void }) {
  const remove = useRemoveSource()
  const subs = source.children_count ?? 0
  return (
    <ConfirmDelete
      title="Supprimer cette source ?"
      confirmLabel="Supprimer la source"
      pending={remove.isPending}
      error={remove.error}
      onClose={onClose}
      onConfirm={() => {
        remove.mutate(source.id, { onSuccess: onClose })
      }}
    >
      <p>
        « {sourceName(source)} » quitte la bibliothèque, les catégories et les missions qui la listaient, avec son
        compteur d’utilisations réussies.
      </p>
      {subs > 0 && <p>Elle a {plural(subs, 'sous-source')} : supprimez-les d’abord.</p>}
    </ConfirmDelete>
  )
}
