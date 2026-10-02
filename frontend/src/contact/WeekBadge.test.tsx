import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { WeekBadge } from './WeekBadge'

describe('WeekBadge', () => {
  it('writes the year of a week that is not in the current year, and always gives it in the tooltip', () => {
    render(
      <>
        <WeekBadge week={{ year: 2026, week: 40 }} today="2026-09-30" />
        <WeekBadge week={{ year: 2027, week: 2 }} today="2026-09-30" />
      </>,
    )
    expect(screen.getByText('S40')).toBeInTheDocument()
    expect(screen.getByTitle('Semaine 40 de 2026, du lun. 28 sept.')).toBeInTheDocument()
    expect(screen.getByText('S02 · 2027')).toBeInTheDocument()
    expect(screen.getByText('Prochaine action : Semaine 2 de 2027, du lun. 11 janv.')).toBeInTheDocument()
  })
})
