import '@fontsource-variable/inter/wght.css'
import './theme/tokens.css'
import './theme/base.css'
import './theme/accent.css'

import { QueryClientProvider } from '@tanstack/react-query'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { createBrowserRouter, RouterProvider } from 'react-router'

import { createQueryClient } from './api/queryClient'
import { routes } from './routes'
import './theme/motion.css'
import { applyAccent, readStoredAccent } from './theme/accent'
import { installScrollActivity } from './theme/scrollActivity'
import { ThemeProvider } from './theme/ThemeProvider'

applyAccent(readStoredAccent())
installScrollActivity()

const router = createBrowserRouter(routes)
const queryClient = createQueryClient()

const container = document.getElementById('root')
if (!container) throw new Error('Missing #root element')

createRoot(container).render(
  <StrictMode>
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </ThemeProvider>
  </StrictMode>,
)
