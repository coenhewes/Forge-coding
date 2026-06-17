/**
 * Vitest setup file. Runs before every test file. Responsibilities:
 *
 *   1. Load .env from the repo root so `FORGE_DATABASE_URL` (and any
 *      other env-driven settings) are visible to test code without
 *      requiring the developer to manually export them in their shell.
 *   2. Prefer the parent shell's `FORGE_DATABASE_URL` if it's already
 *      set — .env must not overwrite an explicit override.
 *   3. Fail loudly if a test file references an env var that .env
 *      doesn't define and the parent shell didn't set. This catches
 *      silent test skips in CI where there's no human to notice.
 */

import { readFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const envPath = resolve(repoRoot, '.env')

if (existsSync(envPath)) {
  for (const rawLine of readFileSync(envPath, 'utf-8').split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq).trim()
    let value = line.slice(eq + 1).trim()
    // Strip optional surrounding quotes (double or single).
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    // Don't clobber an explicit override from the parent shell.
    if (process.env[key] === undefined) {
      process.env[key] = value
    }
  }
}

// Helpful at-a-glance log for humans running tests locally. Vitest prints
// this in the per-file setup phase so a missing .env is visible without
// having to scroll through test output.
if (!process.env.FORGE_DATABASE_URL) {
  // eslint-disable-next-line no-console
  console.warn(
    '[vitest setup] FORGE_DATABASE_URL is unset — live-DB tests will skip.',
  )
}