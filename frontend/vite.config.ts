import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

// Ports are overridable so several checkouts (git worktrees) can run side by side — see
// doc/process/runbook-local-dev.md. Defaults: Vite 5173, proxying /api to the uvicorn dev server on 8042.
const WEB_PORT = Number(process.env.VIPER_WEB_PORT ?? 5173)
const API_TARGET = process.env.VIPER_API_TARGET ?? 'http://127.0.0.1:8042'

export default defineConfig({
  plugins: [react()],
  server: {
    port: WEB_PORT,
    strictPort: true,
    proxy: { '/api': API_TARGET },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    // Vitest blanks CSS by default; `?raw` imports must see the real file (token contrast + colour guard tests).
    css: { include: [/\.css\?raw$/] },
  },
})
