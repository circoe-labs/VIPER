import '@fontsource-variable/inter/wght.css'
import './theme/tokens.css'
import './theme/base.css'
import './theme/accent.css'

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { createBrowserRouter, RouterProvider } from 'react-router'

import { routes } from './routes'
import './theme/motion.css'
import { applyAccent, readStoredAccent } from './theme/accent'
import { ThemeProvider } from './theme/ThemeProvider'

applyAccent(readStoredAccent())

const router = createBrowserRouter(routes)
const queryClient = new QueryClient()

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
