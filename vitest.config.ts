import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Engines write to per-test temp dirs; isolate so they don't share caches.
    pool: 'forks',
  },
})
