import { useState } from 'react'

import { type MissionSkill, useDeleteSkill, useMissionSkills, useSaveSkill } from '../api/missionConfig'
import { Badge } from '../ui/Badge'
import { Button } from '../ui/Button'
import { Modal } from '../ui/Dialog'
import { EmptyState } from '../ui/EmptyState'
import { TextAreaField, TextField } from '../ui/fields'
import { BoltIcon, PencilIcon, PlusIcon, SaveIcon, TrashIcon } from '../ui/icons'
import { ConfirmDelete, ErrorNote, plural, QueryState } from './adminShared'

// Administration › Skills: reusable blocks of instructions. A skill grants no tool and no capability; categories list
// them as defaults and a mission may pick its own.
export function SkillsAdmin() {
  const skills = useMissionSkills()
  const [editing, setEditing] = useState<MissionSkill | 'new' | null>(null)
  const [deleting, setDeleting] = useState<MissionSkill | null>(null)
  return (
    <>
      <div className="adm-toolbar">
        <p className="adm-card__text">
          Un skill est un bloc de consignes réutilisable. Il ne donne accès à aucun outil : il dit seulement à l’agent
          comment s’y prendre.
        </p>
        <Button
          variant="primary"
          icon={PlusIcon}
          onClick={() => {
            setEditing('new')
          }}
        >
          Nouveau skill
        </Button>
      </div>
      <QueryState query={skills} what="Skills">
        {(rows) =>
          rows.length === 0 ? (
            <EmptyState
              icon={BoltIcon}
              title="Aucun skill pour l’instant"
              description="Créez un premier bloc de consignes, puis rattachez-le à une catégorie ou à une mission."
            />
          ) : (
            <ul className="adm-grid" aria-label="Skills">
              {rows.map((skill) => (
                <li key={skill.id} className="adm-card">
                  <div className="adm-card__head">
                    <h2 className="adm-card__title">{skill.name}</h2>
                  </div>
                  {skill.description && <p className="adm-card__text">{skill.description}</p>}
                  <p className="adm-card__text">{skill.content.length > 180 ? `${skill.content.slice(0, 177)}…` : skill.content}</p>
                  <ul className="adm-card__chips" aria-label="Utilisation">
                    <li>
                      <Badge>{plural(skill.categories_count, 'catégorie')}</Badge>
                    </li>
                    <li>
                      <Badge>{plural(skill.missions_count, 'mission')}</Badge>
                    </li>
                  </ul>
                  <div className="adm-card__actions">
                    <Button
                      size="sm"
                      icon={PencilIcon}
                      aria-label={`Modifier le skill ${skill.name}`}
                      onClick={() => {
                        setEditing(skill)
                      }}
                    >
                      Modifier
                    </Button>
                    <Button
                      size="sm"
                      variant="danger"
                      icon={TrashIcon}
                      aria-label={`Supprimer le skill ${skill.name}`}
                      onClick={() => {
                        setDeleting(skill)
                      }}
                    >
                      Supprimer
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )
        }
      </QueryState>
      {editing && (
        <SkillEditor
          skill={editing === 'new' ? null : editing}
          onClose={() => {
            setEditing(null)
          }}
        />
      )}
      {deleting && (
        <DeleteSkill
          skill={deleting}
          onClose={() => {
            setDeleting(null)
          }}
        />
      )}
    </>
  )
}

function SkillEditor({ skill, onClose }: { skill: MissionSkill | null; onClose: () => void }) {
  const save = useSaveSkill(skill?.id ?? null)
  const [name, setName] = useState(skill?.name ?? '')
  const [description, setDescription] = useState(skill?.description ?? '')
  const [content, setContent] = useState(skill?.content ?? '')
  const canSave = name.trim() !== '' && content.trim() !== ''
  return (
    <Modal
      open
      size="lg"
      title={skill ? 'Modifier le skill' : 'Nouveau skill'}
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
                { name: name.trim(), description: description.trim() || null, content: content.trim() },
                { onSuccess: onClose },
              )
            }}
          >
            Enregistrer
          </Button>
        </>
      }
    >
      <div className="adm-form">
        <TextField
          label="Nom"
          required
          maxLength={100}
          value={name}
          onChange={(event) => {
            setName(event.target.value)
          }}
        />
        <TextField
          label="Description"
          maxLength={500}
          value={description}
          hint="Quand l’utiliser : une phrase."
          onChange={(event) => {
            setDescription(event.target.value)
          }}
        />
        <TextAreaField
          label="Instructions"
          required
          rows={10}
          maxLength={5000}
          value={content}
          hint="Texte donné tel quel à l’agent. Aucun outil ni droit n’est accordé par un skill."
          onChange={(event) => {
            setContent(event.target.value)
          }}
        />
        <ErrorNote error={save.error} fallback="Le skill n’a pas pu être enregistré." />
      </div>
    </Modal>
  )
}

function DeleteSkill({ skill, onClose }: { skill: MissionSkill; onClose: () => void }) {
  const remove = useDeleteSkill()
  const places = skill.categories_count + skill.missions_count
  return (
    <ConfirmDelete
      title="Supprimer ce skill ?"
      confirmLabel="Supprimer le skill"
      pending={remove.isPending}
      error={remove.error}
      onClose={onClose}
      onConfirm={() => {
        remove.mutate(skill.id, { onSuccess: onClose })
      }}
    >
      <p>
        « {skill.name} » est supprimé.{' '}
        {places > 0
          ? `Il est retiré de ${plural(skill.categories_count, 'catégorie')} et de ${plural(skill.missions_count, 'mission')}.`
          : 'Aucune catégorie ni mission ne l’utilise.'}
      </p>
    </ConfirmDelete>
  )
}
