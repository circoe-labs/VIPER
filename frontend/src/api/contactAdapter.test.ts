import { describe, expect, it } from 'vitest'

import { toRow } from './contact'

describe('Contact API row adapter (sequences-rework answers)', () => {
  it('reshapes a row: due week, to send, messages by step', () => {
    const row = toRow({
      id: 'p1',
      next_due_at: '2026-10-05T07:00:00Z',
      next_due_week: '2026-W41',
      to_send: true,
      next_step: 'r1',
      messages: [
        { rank: 0, step: 'contact', status: 'sent' },
        { rank: 1, step: 'r1', status: 'draft' },
      ],
    } as never)
    expect(row).toMatchObject({
      planned_contact_at: '2026-10-05T07:00:00Z',
      next_action_week: '2026-W41',
      due: true,
      next_step: 'r1',
      messages: { contact: 'sent', r1: 'draft' },
    })
    expect(row).not.toHaveProperty('to_send')
  })
})
