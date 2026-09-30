import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { TRACKING_STATUSES } from '../api/prospection'
import { cancelledNotice } from './QuickWeekPlanner'
import { StateBadge, WeekBadge } from './TrackingBadges'

describe('Contact badges', () => {
  it('shows no state badge while neutral, and every other state as glyph + label', () => {
    const { container } = render(<StateBadge status="neutral" />)
    expect(container).toBeEmptyDOMElement()
    render(<StateBadge status={null} />)

    const labels = TRACKING_STATUSES.filter((status) => status !== 'neutral').map((status) => {
      const { container: badge } = render(<StateBadge status={status} />)
      expect(badge.querySelector('svg')).not.toBeNull()
      return badge.textContent
    })
    expect(labels).toEqual([
      'État : Contacté',
      'État : R1',
      'État : R2',
      'État : Réponse reçue',
      'État : RDV pris',
      'État : Failure',
      'État : Ignoré',
    ])
  })

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

  it('words the messages a state change cancelled', () => {
    expect(cancelledNotice(1)).toBe('1 message non envoyé annulé.')
    expect(cancelledNotice(3)).toBe('3 messages non envoyés annulés.')
  })
})
