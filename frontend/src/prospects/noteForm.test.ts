import { describe, expect, it } from 'vitest'

import { ApiError } from '../api/client'
import { draftFromNote, formatDelta, newNoteDraft, noteRefusalMessage, parseDelta, toNoteInput, validateNote } from './noteForm'

describe('note form', () => {
  it('starts dated today, with nothing else', () => {
    expect(newNoteDraft('2026-09-11')).toEqual({ fact: '', day: '2026-09-11', delta: '', source_type: '', source_label: '' })
  })

  it('writes signed deltas as text', () => {
    expect([formatDelta(5), formatDelta(-10), formatDelta(0)]).toEqual(['+5', '-10', '0'])
  })

  it('reads a delta only when it is a whole signed number', () => {
    expect([parseDelta('+5'), parseDelta(' -10 '), parseDelta('0'), parseDelta(''), parseDelta('2.5'), parseDelta('abc')]).toEqual([5, -10, 0, null, null, null])
  })

  it('validates the fact and the delta bounds', () => {
    const base = newNoteDraft('2026-09-11')
    expect(validateNote({ ...base, fact: '  ' }).fact).toBe('Saisissez le fait.')
    expect(validateNote({ ...base, fact: 'x'.repeat(1001) }).fact).toBe('1000 caractères au plus.')
    expect(validateNote({ ...base, fact: 'x'.repeat(1000) })).toEqual({})
    expect(validateNote({ ...base, fact: 'ok', delta: '51' }).delta).toBe('Un entier de -50 à +50.')
    expect(validateNote({ ...base, fact: 'ok', delta: '-50' })).toEqual({})
    expect(validateNote({ ...base, fact: 'ok', delta: '1.5' }).delta).toBeDefined()
  })

  it('sends empty optional fields as null and a zero delta as 0', () => {
    expect(toNoteInput({ ...newNoteDraft('2026-09-11'), fact: ' Fait ', day: '', delta: '0' })).toEqual({
      fact_text: 'Fait',
      noted_on: null,
      source_type: null,
      source_label: null,
      score_delta: 0,
    })
  })

  it('round-trips a stored note into its draft', () => {
    const draft = draftFromNote({
      id: 'n',
      prospect_id: 'p',
      fact_text: 'Fait',
      noted_on: null,
      source_type: 'web',
      source_label: 'site',
      score_delta: -3,
      created_at: '',
      updated_at: '',
    })
    expect(draft).toEqual({ fact: 'Fait', day: '', delta: '-3', source_type: 'web', source_label: 'site' })
  })

  it('words the server’s refusals and falls back to a generic failure', () => {
    const refused = (detail: unknown) => noteRefusalMessage(new ApiError(422, 'x', detail))
    expect(refused({ code: 'invalid', field: 'fact_text', reason: 'blank' })).toBe('Saisissez le fait.')
    expect(refused({ code: 'invalid', field: 'score_delta', reason: 'range' })).toContain('-50')
    expect(refused({ code: 'not_found' })).toContain('n’existe plus')
    expect(noteRefusalMessage(new Error('network'))).toContain('a échoué')
  })
})
