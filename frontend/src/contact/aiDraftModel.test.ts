import { describe, expect, it } from 'vitest'

import { ApiError } from '../api/client'
import type { GenerationResult } from '../api/contact'
import { message } from '../test/contactApi'
import {
  aiAvailability,
  formatCount,
  generatedNote,
  generationConfirmation,
  generationNotice,
  generationPayload,
  generationRefusal,
  INSTRUCTION_MAX_LENGTH,
} from './aiDraftModel'

const refusal = (status: number, code: string) => new ApiError(status, 'failed', { code, message: code })

describe('AI drafting: the button', () => {
  it('« Générer » on an empty step, « Régénérer » once a text is saved; hidden when the step cannot be edited', () => {
    expect(aiAvailability({ message: null, editable: true, available: true, busy: false })).toEqual({
      show: true,
      enabled: true,
      label: 'Générer avec l’IA',
      note: null,
    })
    const empty = message('contact', 'draft', { subject: '', body_text: ' ' })
    expect(aiAvailability({ message: empty, editable: true, available: true, busy: false }).label).toBe('Générer avec l’IA')
    expect(aiAvailability({ message: message('contact', 'draft'), editable: true, available: true, busy: true })).toMatchObject({
      label: 'Régénérer avec l’IA',
      enabled: false,
    })
    expect(aiAvailability({ message: message('contact', 'sent'), editable: false, available: true, busy: false }).show).toBe(false)
  })

  it('disabled on the other tabs while the AI writes one step, saying which', () => {
    expect(
      aiAvailability({ message: null, editable: true, available: true, busy: true, generatingStep: 'contact', step: 'r1' }),
    ).toMatchObject({ enabled: false, note: 'L’IA rédige déjà le message Contact : attendez qu’elle ait fini pour générer celui-ci.' })
    expect(
      aiAvailability({ message: null, editable: true, available: true, busy: true, generatingStep: 'contact', step: 'contact' }),
    ).toMatchObject({ enabled: false, note: null })
  })

  it('formats counts the French way', () => {
    expect(formatCount(1000)).toBe('1 000')
  })

  it('disabled with its reason: not configured, or scheduled (unschedule first)', () => {
    expect(aiAvailability({ message: null, editable: true, available: false, busy: false })).toMatchObject({
      show: true,
      enabled: false,
      note: expect.stringMatching(/pas configurée sur ce serveur/) as unknown,
    })
    expect(aiAvailability({ message: message('contact', 'scheduled'), editable: true, available: true, busy: false })).toMatchObject({
      enabled: false,
      note: expect.stringMatching(/déprogrammez/) as unknown,
    })
  })
})

describe('AI drafting: the request', () => {
  it('sends the revision once the step exists, the trimmed and bounded instruction, and `replace` over a saved text', () => {
    expect(generationPayload(null, '  ')).toEqual({})
    expect(generationPayload(message('contact', 'draft', { revision: 3 }), ' Plus court ')).toEqual({
      expected_revision: 3,
      instruction: 'Plus court',
      replace: true,
    })
    expect(generationPayload(message('r1', 'draft', { subject: '', body_text: '' }), '')).toEqual({ expected_revision: 1 })
    expect(generationPayload(null, 'x'.repeat(1200)).instruction).toHaveLength(INSTRUCTION_MAX_LENGTH)
  })

  it('asks first only when a saved text, unsaved edits or a validation would be lost', () => {
    expect(generationConfirmation('contact', null, false)).toBeNull()
    expect(generationConfirmation('contact', message('contact', 'draft', { subject: '', body_text: '' }), false)).toBeNull()
    const all = generationConfirmation('r1', message('r1', 'validated'), true)
    expect(all?.title).toBe('Régénérer le message R1 ?')
    expect(all?.lines.join(' ')).toMatch(
      /seront remplacés.*modifications non enregistrées.*repassera en Brouillon.*reste un Brouillon/,
    )
    const unsaved = generationConfirmation('contact', null, true)
    expect(unsaved?.title).toBe('Générer le message Contact ?')
    expect(unsaved?.lines[0]).toMatch(/modifications non enregistrées/)
  })
})

describe('AI drafting: outcomes', () => {
  it('says the result is a Brouillon to review, and that a validation was lost', () => {
    const result: GenerationResult = {
      message: message('contact', 'draft'),
      created: false,
      changed: true,
      unvalidated: true,
      generation: { model: 'm-1', prompt_version: 'v' },
    }
    expect(generationNotice('contact', result)).toBe(
      'Brouillon Contact rédigé par l’IA : relisez-le, corrigez-le si besoin, puis validez-le. Il est repassé en Brouillon : à revalider.',
    )
  })

  it('turns every AI code into French, saying nothing was changed', () => {
    for (const [status, code, text] of [
      [503, 'ai_not_configured', /pas configurée sur le serveur/],
      [504, 'ai_timeout', /pas répondu à temps/],
      [429, 'ai_rate_limited', /quota OpenAI/],
      [502, 'ai_auth_failed', /clé OpenAI du serveur a été refusée/],
      [502, 'ai_upstream_error', /a échoué ou est injoignable/],
      [422, 'ai_refused', /refusé de rédiger/],
      [502, 'ai_invalid_output', /inutilisable/],
    ] as const) {
      const view = generationRefusal(refusal(status, code))
      expect(view.message).toMatch(text)
      expect(view.message).toMatch(/Rien n’a été modifié/)
      expect(view.reload).toBe(false)
    }
  })

  it('reloads on a conflict or a closed sequence, and after the browser stopped waiting', () => {
    expect(generationRefusal(refusal(409, 'revision_conflict')).reload).toBe(true)
    expect(generationRefusal(refusal(409, 'prospect_sequence_closed')).message).toMatch(/séquence de ce prospect est close/)
    expect(generationRefusal(refusal(409, 'replace_confirmation_required')).reload).toBe(true)
    const late = generationRefusal(new DOMException('timed out', 'TimeoutError'))
    expect(late.message).toMatch(/Pas de réponse du serveur après 5 min/)
    expect(late.reload).toBe(true)
  })

  it('notes an AI text with its model and prompt version', () => {
    expect(generatedNote(message('contact', 'draft'))).toBeNull()
    const ai = message('contact', 'draft', { generation_model: 'fake-model', generation_prompt_version: 'contact-mail-fr-2026-09-v1' })
    expect(generatedNote(ai)).toEqual({
      text: 'Rédigé par l’IA — à relire avant de valider.',
      hint: 'Modèle fake-model · prompt contact-mail-fr-2026-09-v1',
    })
    expect(generatedNote({ ...ai, status: 'validated' })?.text).toBe('Rédigé par l’IA.')
    // A rewrite of the text, not saved yet: the mention will go.
    expect(generatedNote(ai, true)?.text).toBe('Rédigé par l’IA, modifié par vous : la mention disparaîtra à l’enregistrement.')
  })
})
