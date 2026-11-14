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
import { Badge } from '../ui/Badge'
import { Button } from '../ui/Button'
import { Modal } from '../ui/Dialog'
import { EmptyState } from '../ui/EmptyState'
import { SelectField, TextAreaField, TextField } from '../ui/fields'
import { LockIcon, PencilIcon, PlusIcon, SaveIcon, TagIcon, TrashIcon } from '../ui/icons'
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
        <p className="adm-card__text">
          Une catégorie regroupe des missions du même genre : consigne générale, skills et sources par défaut, icône et
          couleur. Une mission suit ces valeurs tant qu’on ne les modifie pas.
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

// Why a category cannot be deleted, in words (the button is disabled; the same rule is enforced by the server).
export function deletionBlock(category: Pick<MissionCategory, 'is_system' | 'missions_count'>): string | null {
  if (category.is_system) return 'Catégorie intégrée : on la modifie, on ne la supprime pas.'
  if (category.missions_count > 0) {
    return `${plural(category.missions_count, 'mission utilise', 'missions utilisent')} cette catégorie : changez la leur d’abord.`
  }
  return null
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
  const block = deletionBlock(category)
  return (
    <li className="adm-card">
      <div className="adm-card__head" style={categoryAccent(category.color)}>
        <span className="mui-icon-tile" aria-hidden="true">
          <CategoryGlyph iconKey={category.icon} size={20} />
        </span>
        <h2 className="adm-card__title">{category.name}</h2>
      </div>
      {category.description && <p className="adm-card__text">{category.description}</p>}
      <ul className="adm-card__chips" aria-label="Réglages de la catégorie">
        <li>
          <Badge>{MISSION_TYPE_LABELS[category.mission_type]}</Badge>
        </li>
        {category.is_system && (
          <li>
            <Badge icon={LockIcon}>Intégrée</Badge>
          </li>
        )}
        <li>
          <Badge>{plural(category.missions_count, 'mission')}</Badge>
        </li>
        <li>
          <Badge>{plural(category.skills.length, 'skill')} par défaut</Badge>
        </li>
        <li>
          <Badge>{plural(category.sources.length, 'source')} par défaut</Badge>
        </li>
      </ul>
      {block && <p className="adm-card__text">{block}</p>}
      <div className="adm-card__actions">
        <Button size="sm" icon={PencilIcon} aria-label={`Modifier la catégorie ${category.name}`} onClick={onEdit}>
          Modifier
        </Button>
        <Button
          size="sm"
          variant="danger"
          icon={TrashIcon}
          disabled={block !== null}
          aria-label={`Supprimer la catégorie ${category.name}`}
          title={block ?? undefined}
          onClick={onDelete}
        >
          Supprimer
        </Button>
      </div>
    </li>
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
            hint={
              category
                ? 'Définitif : il décide de la façon dont VIPER exécute les missions de cette catégorie.'
                : 'Choisi une fois pour toutes : il décide de la façon dont VIPER exécute les missions.'
            }
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
        <TextAreaField
          label="Consigne générale"
          required
          rows={6}
          maxLength={5000}
          value={prompt}
          hint="Reprise par chaque mission de la catégorie tant qu’elle n’a pas sa propre consigne. Modifier ce texte met à jour ces missions."
          onChange={(event) => {
            setPrompt(event.target.value)
          }}
        />
        <fieldset>
          <legend>Skills par défaut</legend>
          <QueryState query={skills} what="Skills">
            {(rows) => <SkillChecklist skills={rows} value={skillIds} onChange={setSkillIds} />}
          </QueryState>
        </fieldset>
        <fieldset>
          <legend>Sources par défaut</legend>
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
  return (
    <ConfirmDelete
      title="Supprimer cette catégorie ?"
      confirmLabel="Supprimer la catégorie"
      pending={remove.isPending}
      error={remove.error}
      onClose={onClose}
      onConfirm={() => {
        remove.mutate(category.id, { onSuccess: onClose })
      }}
    >
      <p>« {category.name} » est supprimée. Aucune mission ne l’utilise ; les skills et sources restent dans leurs bibliothèques.</p>
    </ConfirmDelete>
  )
}
