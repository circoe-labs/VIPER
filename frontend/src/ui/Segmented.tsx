import { useId } from 'react'

import './segmented.css'

export interface SegmentedOption<T extends string> {
  value: T
  label: string
  // Hover tooltip of the segment.
  title?: string
}

interface SegmentedProps<T extends string> {
  // Accessible name of the group.
  label: string
  value: T
  options: readonly SegmentedOption<T>[]
  onChange: (value: T) => void
  disabled?: boolean
}

// A short list of exclusive choices drawn as one joined control (native radios: arrow keys and form semantics for free).
export function Segmented<T extends string>({ label, value, options, onChange, disabled = false }: SegmentedProps<T>) {
  const name = useId()
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <label key={option.value} className="segmented__option" title={option.title}>
          <input
            type="radio"
            name={name}
            className="segmented__input"
            value={option.value}
            checked={option.value === value}
            disabled={disabled}
            onChange={() => {
              onChange(option.value)
            }}
          />
          <span className="segmented__text">{option.label}</span>
        </label>
      ))}
    </div>
  )
}
