import type { ReactNode } from 'react'

const NUMBER = new Intl.NumberFormat('fr-FR')

export interface Capsule {
  key: string
  label: string
  // Undefined while loading; `failed` shows "indisponible" instead of a figure.
  count: number | undefined
  failed?: boolean
  // What the capsule counts (tooltip).
  hint?: string
  pressed: boolean
  onSelect: () => void
  // Weekly addition: a number is shown as « +N cette semaine »; null = known to be unavailable; undefined = not applicable.
  weekly?: number | null
}

// A compact capsule = a figure AND the filter that opens the matching table (toggle button, pressed = active filter;
// the pressed state carries a border and bold text, never colour alone).
export function EntityCapsules({ label, capsules, note }: { label: string; capsules: readonly Capsule[]; note?: ReactNode }) {
  return (
    <div className="capsules" role="group" aria-label={label}>
      {capsules.map(({ key, label: text, count, failed, hint, pressed, onSelect, weekly }) => (
        <button key={key} type="button" className="capsule" aria-pressed={pressed} title={hint} onClick={onSelect}>
          <span className="capsule__label">{text}</span>
          <strong className="capsule__count">{failed ? 'indisponible' : count === undefined ? '…' : NUMBER.format(count)}</strong>
          {weekly === null && <span className="capsule__delta capsule__delta--unknown">ajouts de la semaine indisponibles</span>}
          {typeof weekly === 'number' && <span className="capsule__delta">+{NUMBER.format(weekly)} cette semaine</span>}
        </button>
      ))}
      {note && <p className="capsules__note">{note}</p>}
    </div>
  )
}
