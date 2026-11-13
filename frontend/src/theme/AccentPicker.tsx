import { useState } from 'react'

import { ACCENTS, type AccentId, readStoredAccent, saveAccent } from './accent'
import './accent.css'

// « Ma couleur » : un petit sélecteur de couleur d'accent (boutons, liens actifs, graphiques), propre à ce navigateur.
export function AccentPicker() {
  const [accent, setAccent] = useState<AccentId>(readStoredAccent)
  return (
    <details className="accent-picker">
      <summary className="accent-picker__summary" aria-label="Choisir ma couleur">
        <span className="accent-picker__dot" aria-hidden="true" />
      </summary>
      <div className="accent-picker__panel" role="radiogroup" aria-label="Couleur d’accent">
        {ACCENTS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="radio"
            aria-checked={accent === item.id}
            aria-label={item.label}
            title={item.label}
            className="accent-picker__swatch"
            style={{ background: item.swatch }}
            onClick={() => {
              saveAccent(item.id)
              setAccent(item.id)
            }}
          />
        ))}
      </div>
    </details>
  )
}
