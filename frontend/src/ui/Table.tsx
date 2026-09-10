import type { ReactNode } from 'react'

import './table.css'

interface TableProps {
  // Accessible name of the table and of its scroll region (visually hidden).
  caption: string
  // `compact` is for the Database explorer; Prospection-style lists keep `comfortable`.
  density?: 'comfortable' | 'compact'
  children: ReactNode
}

// Base table: scrollable, keyboard-focusable region with a sticky header. Children are <thead>/<tbody>.
export function Table({ caption, density = 'comfortable', children }: TableProps) {
  return (
    <div className="table-scroll" role="region" aria-label={caption} tabIndex={0}>
      <table className={`table table--${density}`}>
        <caption className="visually-hidden">{caption}</caption>
        {children}
      </table>
    </div>
  )
}
