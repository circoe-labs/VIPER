import { describe, expect, it } from 'vitest'

import { savedNotice, trackingPlan } from './TrackingPanel'

const S40 = { year: 2026, week: 40 }
const S41 = { year: 2026, week: 41 }

describe('tracking plan', () => {
  it('sends only what changed', () => {
    expect(trackingPlan({ status: 'neutral', week: S40 }, { status: 'neutral', week: undefined })).toEqual({
      shownWeek: S40,
      patch: {},
      dirty: false,
    })
    expect(trackingPlan({ status: 'neutral', week: S40 }, { status: 'neutral', week: S41 }).patch).toEqual({ next_action_week: S41 })
    expect(trackingPlan({ status: 'neutral', week: S40 }, { status: 'contacted', week: undefined }).patch).toEqual({ status: 'contacted' })
  })

  it('shows the week cleared by a week-clearing state, and keeps one chosen on purpose', () => {
    const cleared = trackingPlan({ status: 'r1', week: S40 }, { status: 'failure', week: undefined })
    expect(cleared).toEqual({ shownWeek: null, patch: { status: 'failure' }, dirty: true })
    expect(trackingPlan({ status: 'r1', week: S40 }, { status: 'failure', week: S40 }).patch).toEqual({
      status: 'failure',
      next_action_week: S40,
    })
  })

  it('never sends a week with « Ignoré »', () => {
    expect(trackingPlan({ status: 'r2', week: S40 }, { status: 'ignored', week: S41 })).toEqual({
      shownWeek: null,
      patch: { status: 'ignored' },
      dirty: true,
    })
  })
})

describe('saved notice', () => {
  it('counts the cancelled messages and warns about those already leaving', () => {
    expect(savedNotice({ cancelled_messages: 0, in_flight_messages: 0 })).toEqual({ text: 'Suivi enregistré.', warning: null })
    expect(savedNotice({ cancelled_messages: 2, in_flight_messages: 1 })).toEqual({
      text: 'Suivi enregistré. 2 messages non envoyés annulés.',
      warning: 'Un message était déjà en cours d’envoi : il n’a pas pu être arrêté et peut encore partir.',
    })
    expect(savedNotice({ cancelled_messages: 1, in_flight_messages: 2 }).warning).toBe(
      '2 messages étaient déjà en cours d’envoi : ils n’ont pas pu être arrêtés et peuvent encore partir.',
    )
  })
})
