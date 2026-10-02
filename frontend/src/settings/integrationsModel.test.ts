import { describe, expect, it } from 'vitest'

import { ApiError } from '../api/client'
import { fromDraft, KEY_REQUIRED_WITH_BASE_URL, saveRefusal } from './integrationsModel'
import { toolboxFailure } from './toolboxCopy'

// Paramètres › Connexions (S8, QA rework): form values and refusals in French.

describe('integration settings: values and refusals', () => {
  it('an emptied text is null (back to the default), never ""', () => {
    expect(fromDraft('contact_booking_url', '   ')).toBeNull()
    expect(fromDraft('contact_booking_url', ' https://rdv.exemple.example ')).toBe('https://rdv.exemple.example')
    expect(fromDraft('openai_timeout_ms', '2,5')).toBe(2500)
    expect(fromDraft('openai_max_retries', '1.5')).toBeInstanceOf(Error)
  })

  it('puts FastAPI’s own 422 under the field it names (e.g. a key too long)', () => {
    const error = new ApiError(422, 'PUT failed', [{ type: 'string_too_long', loc: ['body', 'openai_api_key'], msg: 'too long' }])
    expect(saveRefusal(error)).toMatchObject({ field: 'openai_api_key' })
  })

  it('says why a new API address needs the key again', () => {
    const error = new ApiError(422, 'PUT failed', { code: 'invalid', field: 'openai_api_key', reason: 'required_with_base_url' })
    expect(saveRefusal(error)).toEqual({ field: 'openai_api_key', message: KEY_REQUIRED_WITH_BASE_URL })
  })

  it('says a settings file the server cannot write', () => {
    const error = new ApiError(503, 'PUT failed', { code: 'settings_storage_unavailable', message: 'x' })
    expect(saveRefusal(error).message).toMatch(/rien n’a été enregistré ni appliqué/)
  })
})

describe('connecting the Toolbox: a refused return address (S8 QA M3)', () => {
  it('says to open VIPER over https or on localhost', () => {
    const error = new ApiError(422, 'POST failed', { code: 'invalid', field: 'toolbox_oauth_redirect_uri', message: 'x' })
    expect(toolboxFailure(error)).toBe(
      'adresse https attendue (http seulement sur localhost) : ouvrez VIPER en https ou sur localhost pour vous connecter',
    )
  })

  it('says a connection interrupted by a change of settings', () => {
    const error = new ApiError(409, 'POST failed', { code: 'toolbox_connection_interrupted', message: 'x' })
    expect(toolboxFailure(error)).toMatch(/interrompue par un changement de réglage/)
  })
})
