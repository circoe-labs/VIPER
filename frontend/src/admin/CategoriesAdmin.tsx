import { useState } from 'react'

import {
  type MissionCategory,
  useDeleteCategory,
  useMissionCategories,
  useMissionSkills,
  useSaveCategory,
  useSourceLibrary,
} from '../api/missionConfig'
import { MISSION_TYPES, type MissionType } from '../api/missions'
import { CategoryGlyph } from '../missions/CategoryGlyph'
import { CATEGORY_ICONS, categoryAccent, DEFAULT_CATEGORY_COLOR } from '../missions/categoryVisual'
import { SkillChecklist, SourceTreePicker } from '../missions/ConfigPickers'
import { MISSION_TYPE_LABELS } from '../missions/labels'
import { Button } from '../ui/Button'
import { Modal } from '../ui/Dialog'
import { EmptyState } from '../ui/EmptyState'
import { SelectField, TextAreaField, TextField } from '../ui/fields'
import { InfoTip } from '../ui/InfoTip'
import { useRowMenu } from '../ui/RowMenu'
import { BoltIcon, LinkIcon, PencilIcon, PlusIcon, SaveIcon, TagIcon, TrashIcon } from '../ui/icons'
import { ConfirmDelete, ErrorNote, plural, QueryState } from './adminShared'

// Administration › Catégories: what a person picks when creating a mission. A category carries its icon and colour
// (the visual identity of its missions), a general prompt and default skills / sources; a mission follows them until it
// overrides them. The technical type is chosen once and never changes (it decides how VIPER runs the mission).
export function CategoriesAdmin() {
  const categories = useMissionCategories()
  const [editing, setEditing] = useState<MissionCategory | 'new' | null>(null)
  const [deleting, setDeleting] = useState<MissionCategory | null>(null)
  return (
    <>
      <div className="adm-toolbar">
        <p className="adm-toolbar__hint">
          <span>Catégories</span>
          <InfoTip label="Aide : catégories de mission">
            Une catégorie regroupe des missions du même genre : consigne générale, skills et sources, icône
            et couleur. Une mission suit ces valeurs tant qu’on ne les modifie pas.
          </InfoTip>
        </p>
        <Button
          variant="primary"
          icon={PlusIcon}
          onClick={() => {
            setEditing('new')
          }}
        >
          Nouvelle catégorie
        </Button>
      </div>
      <QueryState query={categories} what="Catégories">
        {(rows) =>
          rows.length === 0 ? (
            <EmptyState icon={TagIcon} title="Aucune catégorie" description="Créez la première catégorie de mission." />
          ) : (
            <ul className="adm-grid" aria-label="Catégories de mission">
              {rows.map((category) => (
                <CategoryCard
                  key={category.id}
                  category={category}
                  onEdit={() => {
                    setEditing(category)
                  }}
                  onDelete={() => {
                    setDeleting(category)
                  }}
                />
              ))}
            </ul>
          )
        }
      </QueryState>
      {editing && (
        <CategoryEditor
          category={editing === 'new' ? null : editing}
          onClose={() => {
            setEditing(null)
          }}
        />
      )}
      {deleting && (
        <DeleteCategory
          category={deleting}
          onClose={() => {
            setDeleting(null)
          }}
        />
      )}
    </>
  )
}

function CategoryCard({
  category,
  onEdit,
  onDelete,
}: {
  category: MissionCategory
  onEdit: () => void
  onDelete: () => void
}) {
  const [listing, setListing] = useState<'skills' | 'sources' | null>(null)
  const close = () => {
    setListing(null)
  }
  const rowMenu = useRowMenu<MissionCategory>(
    (row) => `Actions de la catégorie ${row.name}`,
    () => [
      { id: 'edit', label: 'Modifier', icon: PencilIcon, onSelect: onEdit },
      { id: 'delete', label: 'Supprimer', icon: TrashIcon, danger: true, onSelect: onDelete },
    ],
  )
  return (
    <li
      className="adm-card adm-card--clickable"
      onContextMenu={rowMenu.onContextMenu(category)}
      onClick={(event) => {
        // A click on the card itself edits it; the buttons inside (« … », skills, sources) keep their own action.
        if (!(event.target as HTMLElement).closest('button, a')) onEdit()
      }}
    >
      <div className="adm-card__menu">{rowMenu.button(category)}</div>
      {rowMenu.menu}
      <div className="adm-card__head" style={categoryAccent(category.color)}>
        <span className="mui-icon-tile" aria-hidden="true">
          <CategoryGlyph iconKey={category.icon} size={20} />
        </span>
        <h2 className="adm-card__title">{category.name}</h2>
      </div>
      {category.description && <p className="adm-card__text">{category.description}</p>}
      <div className="adm-tiles">
        <button
          type="button"
          className="adm-tile"
          onClick={() => {
            setListing('skills')
          }}
        >
          <BoltIcon size={16} />
          <span className="adm-tile__label">Skills</span>
          <span className="adm-tile__count">{category.skills.length}</span>
        </button>
        <button
          type="button"
          className="adm-tile"
          onClick={() => {
            setListing('sources')
          }}
        >
          <LinkIcon size={16} />
          <span className="adm-tile__label">Sources</span>
          <span className="adm-tile__count">{category.sources.length}</span>
        </button>
      </div>
      {listing && (
        <Modal
          open
          size="sm"
          title={`${listing === 'skills' ? 'Skills' : 'Sources'} · ${category.name}`}
          onClose={close}
          footer={<Button onClick={close}>Fermer</Button>}
        >
          {listing === 'skills' ? (
            <DefaultList names={category.skills.map((skill) => ({ id: skill.id, text: skill.name }))} empty="Aucun skill." />
          ) : (
            <DefaultList
              names={category.sources.map((source) => ({ id: source.id, text: source.label ?? source.url }))}
              empty="Aucune source."
            />
          )}
        </Modal>
      )}
    </li>
  )
}

function DefaultList({ names, empty }: { names: { id: string; text: string }[]; empty: string }) {
  if (names.length === 0) return <p className="adm-card__text">{empty}</p>
  return (
    <ul className="adm-list">
      {names.map((item) => (
        <li key={item.id}>{item.text}</li>
      ))}
    </ul>
  )
}

const HEX = /^#[0-9a-fA-F]{6}$/

// The one-page editor. Colour is chosen with the native colour input and shown as its hex text too, so the value is
// never only a swatch.
function CategoryEditor({ category, onClose }: { category: MissionCategory | null; onClose: () => void }) {
  const save = useSaveCategory(category?.id ?? null)
  const skills = useMissionSkills()
  const sources = useSourceLibrary({ order: 'name' })
  const [name, setName] = useState(category?.name ?? '')
  const [description, setDescription] = useState(category?.description ?? '')
  const [icon, setIcon] = useState(category?.icon ?? 'sparkles')
  const [color, setColor] = useState(category?.color ?? DEFAULT_CATEGORY_COLOR)
  const [type, setType] = useState<MissionType>(category?.mission_type ?? 'other')
  const [prompt, setPrompt] = useState(category?.general_prompt ?? '')
  const [skillIds, setSkillIds] = useState<string[]>(category?.skills.map((skill) => skill.id) ?? [])
  const [sourceIds, setSourceIds] = useState<string[]>(category?.sources.map((source) => source.id) ?? [])
  const canSave = name.trim() !== '' && prompt.trim() !== '' && HEX.test(color)
  return (
    <Modal
      open
      size="lg"
      title={category ? 'Modifier la catégorie' : 'Nouvelle catégorie'}
      onClose={onClose}
      footer={
        <>
          <Button disabled={save.isPending} onClick={onClose}>
            Annuler
          </Button>
          <Button
            variant="primary"
            icon={SaveIcon}
            loading={save.isPending}
            disabled={!canSave}
            onClick={() => {
              save.mutate(
                {
                  name: name.trim(),
                  description: description.trim() || null,
                  icon,
                  color,
                  general_prompt: prompt.trim(),
                  mission_type: type,
                  skill_ids: skillIds,
                  source_ids: sourceIds,
                },
                { onSuccess: onClose },
              )
            }}
          >
            Enregistrer
          </Button>
        </>
      }
    >
      <div className="adm-form" style={categoryAccent(color)}>
        <div className="adm-form__row">
          <TextField
            label="Nom"
            required
            maxLength={100}
            value={name}
            onChange={(event) => {
              setName(event.target.value)
            }}
          />
          <SelectField
            label="Type d’exécution"
            value={type}
            disabled={category !== null}
            onChange={(event) => {
              setType(event.target.value as MissionType)
            }}
          >
            {MISSION_TYPES.map((value) => (
              <option key={value} value={value}>
                {MISSION_TYPE_LABELS[value]}
              </option>
            ))}
          </SelectField>
        </div>
        <TextField
          label="Description"
          maxLength={500}
          value={description}
          onChange={(event) => {
            setDescription(event.target.value)
          }}
        />
        <fieldset>
          <legend>Icône</legend>
          <div className="adm-icons" role="radiogroup" aria-label="Icône">
            {Object.entries(CATEGORY_ICONS).map(([key, { label }]) => (
              <button
                key={key}
                type="button"
                role="radio"
                aria-checked={icon === key}
                aria-label={label}
                title={label}
                className="adm-icon-choice"
                onClick={() => {
                  setIcon(key)
                }}
              >
                <CategoryGlyph iconKey={key} size={20} />
              </button>
            ))}
          </div>
        </fieldset>
        <div className="adm-color">
          <label className="field__label" htmlFor="category-color">
            Couleur
          </label>
          <input
            id="category-color"
            type="color"
            value={HEX.test(color) ? color : DEFAULT_CATEGORY_COLOR}
            onChange={(event) => {
              setColor(event.target.value)
            }}
          />
          <code>{color}</code>
        </div>
        <div className="adm-labelled">
          <InfoTip label="Aide : type d’exécution et consigne">
            Le type d’exécution est choisi une fois pour toutes : il décide de la façon dont VIPER exécute les
            missions. La consigne générale est reprise par chaque mission de la catégorie tant qu’elle n’a pas la
            sienne ; la modifier met à jour ces missions.
          </InfoTip>
        </div>
        <TextAreaField
          label="Consigne générale"
          required
          rows={6}
          maxLength={5000}
          value={prompt}
          onChange={(event) => {
            setPrompt(event.target.value)
          }}
        />
        <fieldset>
          <legend>Skills</legend>
          <QueryState query={skills} what="Skills">
            {(rows) => <SkillChecklist skills={rows} value={skillIds} onChange={setSkillIds} />}
          </QueryState>
        </fieldset>
        <fieldset>
          <legend>Sources</legend>
          <QueryState query={sources} what="Sources">
            {(rows) => <SourceTreePicker sources={rows} value={sourceIds} onChange={setSourceIds} />}
          </QueryState>
        </fieldset>
        <ErrorNote error={save.error} fallback="La catégorie n’a pas pu être enregistrée." />
      </div>
    </Modal>
  )
}

function DeleteCategory({ category, onClose }: { category: MissionCategory; onClose: () => void }) {
  const remove = useDeleteCategory()
  const used = category.missions_count
  return (
    <ConfirmDelete
      title="Supprimer cette catégorie ?"
      confirmLabel={used > 0 ? 'Supprimer avec ses missions' : 'Supprimer la catégorie'}
      pending={remove.isPending}
      error={remove.error}
      onClose={onClose}
      onConfirm={() => {
        remove.mutate({ id: category.id, confirmCascade: used > 0 }, { onSuccess: onClose })
      }}
    >
      {used > 0 ? (
        <p>
          Cette catégorie est utilisée par {plural(used, 'mission')}. La supprimer supprimera également{' '}
          {used > 1 ? `ces ${String(used)} missions` : 'cette mission'} et annulera leurs tâches en cours. Confirmer ?
        </p>
      ) : (
        <p>« {category.name} » est supprimée. Les skills et sources restent dans leurs bibliothèques.</p>
      )}
    </ConfirmDelete>
  )
}
