import { CheckIcon } from './icons'
import './multi-select.css'

export interface MultiSelectOption<T extends string> {
  value: T
  label: string
  // What choosing it means (tooltip).
  hint?: string
  // Colour of its check box (a status).
  tone?: 'success' | 'info' | 'warning' | 'danger'
}

interface MultiSelectProps<T extends string> {
  label: string
  options: readonly MultiSelectOption<T>[]
  value: readonly T[]
  onChange: (value: T[]) => void
}

// Several choices among a few fixed ones, all visible: a toggle per option with a check mark when on; nothing on means
// « not filtered ». For long lists (roles, companies…) use `Combobox multiple`. The value keeps the options' order.
export function MultiSelect<T extends string>({ label, options, value, onChange }: MultiSelectProps<T>) {
  return (
    <div className="multi-select" role="group" aria-label={label}>
      <span className="multi-select__label" aria-hidden="true">{label}</span>
      <div className="multi-select__options">
        {options.map((option) => {
          const on = value.includes(option.value)
          return (
            <button
              key={option.value}
              type="button"
              className="multi-select__option"
              data-tone={option.tone}
              aria-pressed={on}
              title={option.hint}
              onClick={() => { onChange(options.map((item) => item.value).filter((item) => (item === option.value ? !on : value.includes(item)))) }}
            >
              <span className="multi-select__mark" aria-hidden="true">{on ? <CheckIcon size={12} /> : null}</span>
              {option.label}
            </button>
          )
        })}
      </div>
    </div>
  )
}
