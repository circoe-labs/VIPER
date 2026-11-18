import type { ReactNode } from 'react'

import './profile-layout.css'

// Layout primitives of the Profil tab (prospect-sheet redesign S1). They only place cards: every card keeps its own
// content and behaviour. All rows share one gap and one column logic, so the cards line up edge to edge:
//   - ProfileRow `two`   : Résumé | Coordonnées (a lone card takes the whole row)
//   - ProfileRow `three` : Identité | Emploi | Entreprise, cards stretched to the same height
//   - ProfileRow `one`   : a wide card (Relations)
export function ProfileRow({ columns, children }: { columns: 'one' | 'two' | 'three'; children: ReactNode }) {
  return (
    <div className="profile-row" data-columns={columns}>
      {children}
    </div>
  )
}
