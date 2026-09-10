import { SearchIcon } from './icons'
import './search-field.css'

interface SearchFieldProps {
  // Accessible name and placeholder ("Rechercher un rôle").
  label: string
  value: string
  onChange: (value: string) => void
}

// Compact search box for list toolbars: magnifier glyph, visually hidden label, native `type="search"` (Esc clears).
export function SearchField({ label, value, onChange }: SearchFieldProps) {
  return (
    <label className="search-field">
      <SearchIcon size={16} />
      <span className="visually-hidden">{label}</span>
      <input
        type="search"
        placeholder={label}
        value={value}
        onChange={(event) => {
          onChange(event.target.value)
        }}
      />
    </label>
  )
}
