import { afterEach, describe, expect, it, vi } from 'vitest'

import { leaveFor } from './browser'

describe('leaveFor', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('follows an http(s) URL only', () => {
    const assign = vi.fn()
    vi.stubGlobal('location', { assign })

    leaveFor('https://toolbox.exemple.example/authorize?state=x')
    expect(assign).toHaveBeenCalledWith('https://toolbox.exemple.example/authorize?state=x')

    expect(() => {
      leaveFor('javascript:alert(1)')
    }).toThrow('https requis')
    expect(() => {
      leaveFor('pas une adresse')
    }).toThrow('invalide')
    expect(assign).toHaveBeenCalledTimes(1)
  })
})
