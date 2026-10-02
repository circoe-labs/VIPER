import { describe, expect, it } from 'vitest'

import { savedNotice, trackingPlan } from './TrackingPanel'

describe('tracking plan', () => {
  it('sends the state only when it changed — never a week (the next due date is derived)', () => {
    expect(trackingPlan('neutral', 'neutral')).toEqual({ patch: null, dirty: false })
    expect(trackingPlan('neutral', 'response_received')).toEqual({ patch: { status: 'response_received' }, dirty: true })
    expect(trackingPlan('disqualified', 'neutral')).toEqual({ patch: { status: 'neutral' }, dirty: true })
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
