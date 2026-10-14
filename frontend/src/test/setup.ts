import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach, vi } from 'vitest'

import { setCsrfToken } from '../api/client'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  window.localStorage.clear()
  setCsrfToken(null)
  delete document.documentElement.dataset.theme
})

// jsdom has no layout: scrolling an element into view is a no-op there.
Element.prototype.scrollIntoView = () => undefined

// jsdom has no layout: scrolling an element into view is a no-op there.
Element.prototype.scrollIntoView = () => undefined
