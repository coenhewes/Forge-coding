import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts', 'packages/*/tests/**/*.test.ts'],
    // Engines write to per-test temp dirs; isolate so they don't share caches.
    pool: 'forks',
    // Auto-load .env from the repo root so FORGE_DATABASE_URL (and any
    // other env-driven settings) are available without manual export.
    // Without this, tests that depend on a real Postgres connection
    // silently skip because `process.env.FORGE_DATABASE_URL` is empty.
    setupFiles: ['./tests/setup-env.ts'],
  },
})