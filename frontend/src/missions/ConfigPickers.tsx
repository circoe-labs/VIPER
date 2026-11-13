import { useState } from 'react'

import type { MissionSkill } from '../api/missionConfig'
import type { MissionSource } from '../api/missions'
import { Badge } from '../ui/Badge'
import { Checkbox } from '../ui/fields'
import { ChevronDownIcon, ChevronRightIcon } from '../ui/icons'
import './configPickers.css'
import { buildSourceTree, sourceName, usesLabel, usesOf } from './sourceTree'

function toggled(value: readonly string[], id: string): string[] {
  return value.includes(id) ? value.filter((item) => item !== id) : [...value, id]
}

// Instruction skills as a checklist (category defaults and a mission's own list). A skill is a block of instructions,
// never a tool: the hint says so where the choice is made.
export function SkillChecklist({
  skills,
  value,
  onChange,
}: {
  skills: readonly Pick<MissionSkill, 'id' | 'name' | 'description'>[]
  value: readonly string[]
  onChange: (ids: string[]) => void
}) {
  if (skills.length === 0) {
    return <p className="cfg-empty">Aucun skill dans la bibliothèque : un administrateur peut en créer dans Administration › Skills.</p>
  }
  return (
    <ul className="cfg-list" aria-label="Skills">
      {skills.map((skill) => (
        <li key={skill.id}>
          <Checkbox
            label={skill.name}
            hint={skill.description ?? undefined}
            checked={value.includes(skill.id)}
            onChange={() => {
              onChange(toggled(value, skill.id))
            }}
          />
        </li>
      ))}
    </ul>
  )
}

// External research sources as a hierarchy: a root can be expanded to its sub-sources; each shows its successful-use
// count (accepted items it supported). Selecting a root does not select its sub-sources: they are separate choices.
export function SourceTreePicker({
  sources,
  value,
  onChange,
}: {
  sources: readonly MissionSource[]
  value: readonly string[]
  onChange: (ids: string[]) => void
}) {
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set())
  const tree = buildSourceTree(sources)
  if (tree.length === 0) {
    return <p className="cfg-empty">Aucune source dans la bibliothèque pour l’instant.</p>
  }
  const row = (source: MissionSource, own: boolean) => (
    <div className="cfg-source">
      <Checkbox
        label={sourceName(source)}
        hint={
          <>
            {source.label && <span className="cfg-source__url">{source.url} · </span>}
            {usesLabel(own ? (source.successful_uses ?? 0) : usesOf(source))}
          </>
        }
        checked={value.includes(source.id)}
        onChange={() => {
          onChange(toggled(value, source.id))
        }}
      />
    </div>
  )
  return (
    <ul className="cfg-list" aria-label="Sources externes">
      {tree.map(({ source, children }) => {
        const expanded = open.has(source.id)
        return (
          <li key={source.id}>
            <div className="cfg-tree-row">
              {children.length > 0 ? (
                <button
                  type="button"
                  className="cfg-toggle"
                  aria-expanded={expanded}
                  aria-label={`${expanded ? 'Replier' : 'Déplier'} les sous-sources de ${sourceName(source)}`}
                  onClick={() => {
                    setOpen((current) => {
                      const next = new Set(current)
                      if (next.has(source.id)) next.delete(source.id)
                      else next.add(source.id)
                      return next
                    })
                  }}
                >
                  {expanded ? <ChevronDownIcon size={16} /> : <ChevronRightIcon size={16} />}
                </button>
              ) : (
                <span className="cfg-toggle cfg-toggle--none" aria-hidden="true" />
              )}
              {row(source, false)}
              {children.length > 0 && <Badge>{`${String(children.length)} sous-source${children.length > 1 ? 's' : ''}`}</Badge>}
            </div>
            {expanded && children.length > 0 && (
              <ul className="cfg-list cfg-list--nested" aria-label={`Sous-sources de ${sourceName(source)}`}>
                {children.map((child) => (
                  <li key={child.id}>{row(child, true)}</li>
                ))}
              </ul>
            )}
          </li>
        )
      })}
    </ul>
  )
}
