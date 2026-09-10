import { mergeConfig } from 'vite'

import baseConfig from '../vite.config.ts'
import { E2E_API_PORT, E2E_WEB_PORT } from './env.ts'

// The regular dev config on the E2E port, proxying /api to the E2E backend (started by playwright.config.ts).
export default mergeConfig(baseConfig, {
  server: {
    port: E2E_WEB_PORT,
    strictPort: true,
    proxy: { '/api': `http://127.0.0.1:${String(E2E_API_PORT)}` },
  },
})
