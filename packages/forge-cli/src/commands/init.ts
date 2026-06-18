/**
 * `forge init` — idempotent setup.
 *
 *   1. Load or write `.forge/config.json` via `loadConfig` + `initConfig`.
 *   2. Ensure a `.env` exists at the repo root with `FORGE_DATABASE_URL`
 *      (defaults to a local `postgres://forge:forge@localhost:54329/forge`
 *      if neither shell nor .env supplies one). Never clobbers an
 *      existing value.
 *   3. If `FORGE_DATABASE_URL` is set, open the Postgres state store
 *      via `ForgeStateStore.init()` (idempotent: it runs migrations
 *      in their own transactions and skips already-applied versions).
 *   4. Append a minimal `.gitignore` block so `.forge/` and `.env`
 *      stay out of git. If `.gitignore` doesn't exist, create one.
 *
 * Output:
 *   --json   → { ok, exitCode, message, data: { stateDir, envPath, gitignorePath, postgres: { reachable, schemaVersion, applied } } }
 *   --text   → human-readable lines
 *
 * Exit codes:
 *   0  setup completed (or was already complete)
 *   1  unexpected error
 */
import { appendFile, writeFile, access } from 'node:fs/promises'
import { constants as FS } from 'node:fs'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { initConfig, loadConfig, resolveConfig, isInitialized, DEFAULT_STATE_DIR } from '../config.js'
import { ForgeStateStore, defaultStateStoreConfig } from '@forge/state-store'
import type { CommandResult, ParsedArgs } from './output.js'

const DEFAULT_DB_URL = 'postgres://forge:forge@localhost:54329/forge'

const GITIGNORE_BLOCK = [
  '',
  '# Forge',
  '.forge/',
  '.env',
  '.local/',
  '',
].join('\n')

export interface InitData {
  stateDir: string
  envPath: string
  gitignorePath: string
  envCreated: boolean
  envAlreadyPresent: boolean
  gitignorePatched: boolean
  configExisted: boolean
  postgres: {
    reachable: boolean
    schemaVersion?: number
    requiredSchemaVersion?: number
    applied: number[]
    error?: string
  }
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p, FS.F_OK)
    return true
  } catch {
    return false
  }
}

async function ensureEnv(envPath: string): Promise<{ created: boolean; hadValue: boolean }> {
  const cs = process.env.FORGE_DATABASE_URL
  if (await fileExists(envPath)) {
    return { created: false, hadValue: cs !== undefined && cs.length > 0 }
  }
  const lines = ['# Forge', `FORGE_DATABASE_URL=${DEFAULT_DB_URL}`, '']
  await writeFile(envPath, lines.join('\n'), 'utf-8')
  // Surface it to this process so the optional `store.init()` call can use it.
  if (!process.env.FORGE_DATABASE_URL) {
    process.env.FORGE_DATABASE_URL = DEFAULT_DB_URL
  }
  return { created: true, hadValue: false }
}

async function ensureGitignore(gitignorePath: string): Promise<boolean> {
  const wanted = ['.forge/', '.env', '.local/']
  if (!(await fileExists(gitignorePath))) {
    await writeFile(gitignorePath, GITIGNORE_BLOCK, 'utf-8')
    return true
  }
  const { readFile } = await import('node:fs/promises')
  const current = await readFile(gitignorePath, 'utf-8')
  const missing = wanted.filter((w) => !current.includes(w))
  if (missing.length === 0) return false
  const sep = current.endsWith('\n') ? '' : '\n'
  await appendFile(gitignorePath, sep + GITIGNORE_BLOCK, 'utf-8')
  return true
}

export async function runInit(_parsed: ParsedArgs): Promise<CommandResult<InitData>> {
  void _parsed // suppress unused — init takes no positional args beyond flags
  const workDir = process.cwd()
  // Honor FORGE_STATE_DIR for hermetic test runs. When set, the
  // state directory lives there but `.env` and `.gitignore` still
  // go next to the workdir (they're repo-level files).
  const envStateDir = process.env.FORGE_STATE_DIR
  const stateDir = envStateDir && envStateDir.length > 0 ? envStateDir : join(workDir, DEFAULT_STATE_DIR)
  const envPath = join(workDir, '.env')
  const gitignorePath = join(workDir, '.gitignore')

  try {
    const configExisted = isInitialized(stateDir)
    if (configExisted) {
      // Resolve but do not overwrite.
      const existing = await loadConfig(stateDir)
      if (existing) {
        // Touch state subdirs in case any were removed.
        const { mkdir } = await import('node:fs/promises')
        const subdirs = ['tasks', 'evidence', 'evidence/artifacts', 'failures', 'decisions', 'verification', 'checkpoints', 'patches']
        for (const subdir of subdirs) {
          await mkdir(join(stateDir, subdir), { recursive: true })
        }
      } else {
        await initConfig()
      }
    } else {
      await initConfig()
    }

    const envResult = await ensureEnv(envPath)
    const gitignorePatched = await ensureGitignore(gitignorePath)

    // Optional: open Postgres if URL is set.
    const postgresResult: InitData['postgres'] = { reachable: false, applied: [] }
    const dbUrl = process.env.FORGE_DATABASE_URL
    if (dbUrl) {
      const store = new ForgeStateStore({
        config: defaultStateStoreConfig(workDir, dbUrl),
      })
      try {
        const health = await store.init()
        postgresResult.reachable = health.ok
        postgresResult.schemaVersion = health.schemaVersion
        postgresResult.requiredSchemaVersion = health.requiredSchemaVersion
        postgresResult.applied = []
      } catch (err) {
        postgresResult.error = err instanceof Error ? err.message : String(err)
      }
    }

    const data: InitData = {
      stateDir,
      envPath,
      gitignorePath,
      envCreated: envResult.created,
      envAlreadyPresent: envResult.hadValue,
      gitignorePatched,
      configExisted,
      postgres: postgresResult,
    }

    return {
      ok: true,
      exitCode: 0,
      data,
      message: `Initialized Forge at ${stateDir}`,
      textLines: [
        `Initialized Forge at ${stateDir}`,
        `Provider: ${(await loadConfig(stateDir))?.provider.name ?? 'openrouter'}`,
        `Mode: ${(await loadConfig(stateDir))?.mode ?? 'implement'}`,
        envResult.created ? `Wrote .env (FORGE_DATABASE_URL=local default)` : '.env already present',
        gitignorePatched ? '.gitignore patched' : '.gitignore already up to date',
        postgresResult.reachable
          ? `Postgres reachable (schema v${postgresResult.schemaVersion})`
          : dbUrl
            ? `Postgres unreachable: ${postgresResult.error ?? 'unknown'}`
            : 'FORGE_DATABASE_URL not set — skipped Postgres init',
      ],
    }
  } catch (err) {
    return {
      ok: false,
      exitCode: 1,
      data: undefined,
      message: `forge init failed: ${err instanceof Error ? err.message : String(err)}`,
      textLines: [`Error: ${err instanceof Error ? err.message : String(err)}`],
    }
  }
}

// Helper for tests and other consumers that want to construct a Config
// without writing it out.
export function _resolveForTest() {
  return resolveConfig
}
