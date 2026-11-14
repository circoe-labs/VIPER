import { useState } from 'react'

import { Button } from '../ui/Button'
import { Modal } from '../ui/Dialog'
import { SelectField } from '../ui/fields'
import { AlertIcon, ChevronDownIcon } from '../ui/icons'
import { InfoTip } from '../ui/InfoTip'
import { CategoryGlyph } from './CategoryGlyph'
import { categoryAccent } from './categoryVisual'
import type { MissionFormApi } from './useMissionForm'
import './missionCategoryPicker.css'
import './missionUi.css'

// « Type de mission »: a compact field showing the chosen category (icon + colour); clicking it opens a picker over
// the form (own backdrop) with one tile per category. Choosing one applies its defaults (consigne, skills, sources)
// to every field the mission has not overridden, then returns to the form. The selected tile reads « sélectionnée »
// to assistive technology and carries a check frame, not only a colour.
export function MissionCategoryPicker({ form }: { form: MissionFormApi }) {
  const { categoriesQuery, categories, category, kinds, kind } = form
  const [open, setOpen] = useState(false)
  if (categoriesQuery.isPending) {
    return (
      <p className="mcat__state" role="status">
        Chargement des catégories…
      </p>
    )
  }
  if (categoriesQuery.isError) {
    return (
      <div className="mcat__state mcat__state--error" role="alert">
        <AlertIcon size={18} /> Les catégories n’ont pas pu être chargées.
        <Button
          size="sm"
          onClick={() => {
            void categoriesQuery.refetch()
          }}
        >
          Réessayer
        </Button>
      </div>
    )
  }
  return (
    <div className="mcat">
      <div className="field">
        <span className="field__label">
          <span id="mcat-label">Type de mission</span>
          {category?.description && (
            <span className="mcat__tip">
              <InfoTip label="Aide : type de mission">{category.description}</InfoTip>
            </span>
          )}
        </span>
        <button
          type="button"
          className="mcat__trigger mui-accent"
          style={category ? categoryAccent(category.color) : undefined}
          aria-haspopup="dialog"
          aria-labelledby="mcat-label mcat-value"
          onClick={() => {
            setOpen(true)
          }}
        >
          {category && (
            <span className="mui-icon-tile" aria-hidden="true">
              <CategoryGlyph iconKey={category.icon} size={18} />
            </span>
          )}
          <span id="mcat-value" className="mcat__value">
            {category?.name ?? 'Choisir un type'}
          </span>
          <ChevronDownIcon size={18} />
        </button>
      </div>
      {kinds.length > 1 && (
        <div className="mcat__kind">
          <SelectField
            label="Résultat attendu"
            value={kind?.id ?? ''}
            onChange={(event) => {
              const next = kinds.find((item) => item.id === event.target.value)
              if (next) form.setResultKind(next.resultKind)
            }}
          >
            {kinds.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </SelectField>
          {kind?.help && (
            <span className="mcat__tip mcat__tip--field">
              <InfoTip label="Aide : résultat attendu">{kind.help}</InfoTip>
            </span>
          )}
        </div>
      )}
      <Modal
        open={open}
        onClose={() => {
          setOpen(false)
        }}
        size="md"
        title="Type de mission"
        className="dialog--mcat"
      >
        <div className="mcat__tiles" role="radiogroup" aria-label="Type de mission">
          {categories.map((item) => {
            const selected = item.id === category?.id
            return (
              <button
                key={item.id}
                type="button"
                role="radio"
                aria-checked={selected}
                aria-label={item.name}
                className="mcat__tile mui-accent"
                style={categoryAccent(item.color)}
                onClick={() => {
                  form.chooseCategory(item.id)
                  setOpen(false)
                }}
              >
                <span className="mui-icon-tile" aria-hidden="true">
                  <CategoryGlyph iconKey={item.icon} size={20} />
                </span>
                <span className="mcat__text">
                  <span className="mcat__name">{item.name}</span>
                  {item.description && <span className="mcat__desc">{item.description}</span>}
                </span>
              </button>
            )
          })}
        </div>
      </Modal>
    </div>
  )
}
