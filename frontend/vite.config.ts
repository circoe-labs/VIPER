import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

// Backend dev server (uvicorn) — see doc/process/runbook-local-dev.md.
const API_TARGET = 'http://127.0.0.1:8042'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: { '/api': API_TARGET },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
  },
})
