import { Button } from '../ui/Button'
import { SelectField } from '../ui/fields'
import { AlertIcon } from '../ui/icons'
import { CategoryGlyph } from './CategoryGlyph'
import { categoryAccent } from './categoryVisual'
import type { MissionFormApi } from './useMissionForm'
import './missionCategoryPicker.css'
import './missionUi.css'

// « Catégorie »: one tile per category with its icon and colour; choosing one applies its defaults (consigne, skills,
// sources) to every field the mission has not overridden. The choice is stated in words too (the selected tile reads
// « sélectionnée » to assistive technology and carries a check frame, not only a colour).
export function MissionCategoryPicker({ form }: { form: MissionFormApi }) {
  const { categoriesQuery, categories, category, kinds, kind } = form
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
      <div className="mcat__tiles" role="radiogroup" aria-label="Catégorie">
        {categories.map((item) => {
          const selected = item.id === category?.id
          return (
            <button
              key={item.id}
              type="button"
              role="radio"
              aria-checked={selected}
              className="mcat__tile mui-accent"
              style={categoryAccent(item.color)}
              title={item.description ?? undefined}
              onClick={() => {
                form.chooseCategory(item.id)
              }}
            >
              <span className="mui-icon-tile" aria-hidden="true">
                <CategoryGlyph iconKey={item.icon} size={18} />
              </span>
              <span className="mcat__name">{item.name}</span>
            </button>
          )
        })}
      </div>
      {category?.description && <p className="mcat__help">{category.description}</p>}
      {kinds.length > 1 && (
        <SelectField
          label="Résultat attendu"
          value={kind?.id ?? ''}
          hint={kind?.help}
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
      )}
    </div>
  )
}
