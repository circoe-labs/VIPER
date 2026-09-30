import { describe, expect, it } from 'vitest'

import { ApiError } from '../api/client'
import { messageRefusal } from './messages'

function refused(status: number, detail: object) {
  return new ApiError(status, 'failed', detail)
}

describe('messageRefusal', () => {
  it('places the missing parts of an incomplete message on their fields', () => {
    const view = messageRefusal(refused(422, { code: 'message_incomplete', fields: ['subject', 'to', 'body_text'] }))
    expect(view.message).toContain('Message incomplet')
    expect(view.fields).toEqual({
      subject: 'Indiquez l’objet.',
      to: 'Indiquez au moins un destinataire.',
      body: 'Rédigez le corps du message.',
    })
    expect(view.reload).toBe(false)
  })

  it('names the invalid address and the send moment refused', () => {
    expect(messageRefusal(refused(422, { code: 'invalid', field: 'cc.1', reason: 'format' })).fields).toEqual({
      cc: 'Adresse e-mail invalide (adresse n° 2).',
    })
    expect(messageRefusal(refused(422, { code: 'invalid', field: 'subject', reason: 'control_character' })).fields.subject).toContain(
      'Caractère interdit',
    )
    expect(messageRefusal(refused(422, { code: 'invalid', field: 'scheduled_at', reason: 'not_future' })).fields.schedule).toContain(
      'futur',
    )
    expect(messageRefusal(refused(422, { code: 'invalid', field: 'scheduled_at', reason: 'too_far' })).fields.schedule).toContain(
      'plus d’un an',
    )
  })

  it('reloads the sequence when the server’s message differs from the one shown', () => {
    for (const code of [
      'revision_conflict',
      'message_exists',
      'message_sent_immutable',
      'message_cancelled',
      'invalid_transition',
      'dispatch_in_progress',
      'prospect_sequence_closed',
      'prospect_do_not_contact',
      'message_not_found',
    ]) {
      expect(messageRefusal(refused(409, { code })).reload, code).toBe(true)
    }
    expect(messageRefusal(refused(409, { code: 'revision_conflict' })).message).toContain('restent dans le formulaire')
  })

  it('keeps the real cause of an unknown failure', () => {
    expect(messageRefusal(new ApiError(500, 'boom')).message).toContain('HTTP 500')
    expect(messageRefusal(new TypeError('Failed to fetch')).message).toContain('Vérifiez la connexion')
    expect(messageRefusal(refused(403, { code: 'human_actor_required' })).message).toContain('Seule une personne')
  })
})
