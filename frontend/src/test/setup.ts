import '@testing-library/jest-dom/vitest'
import { cleanup, configure } from '@testing-library/react'
import { afterEach, vi } from 'vitest'

import { setCsrfToken } from '../api/client'

// `waitFor` / `findBy*` give up after 1 s by default: too short when the suite runs in parallel.
configure({ asyncUtilTimeout: 4000 })

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
