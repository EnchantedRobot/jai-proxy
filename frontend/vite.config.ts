/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'node:path'

// The archive server, for the dev proxy below.
const SERVER = 'http://localhost:8000'

// Everything on the server that the app calls, as a prefix list. `/api` covers
// both the archive contract (/api/v1) and DataCat's session transport
// (/api/v1/datacat); `/proxy` is the CORS passthrough a provider fetch falls
// back to, and without it Discover cannot work in dev. `/existing` is the
// duplicate guard, still living in the userscript namespace.
const SERVER_PATHS = ['/api', '/proxy', '/health', '/existing']

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  // During the overlap the old `web/` frontend still owns "/", so this app is
  // mounted under a prefix and its assets must be requested from there. At
  // cut-over this becomes '/' (docs/UI_REWRITE_PLAN.md §2.5, §5 Stage 7).
  base: '/next/',
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
    },
  },
  server: {
    proxy: Object.fromEntries(
      SERVER_PATHS.map((prefix) => [
        prefix,
        { target: SERVER, changeOrigin: true },
      ]),
    ),
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    globals: true,
  },
})
