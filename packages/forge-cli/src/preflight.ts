import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ForgeStateStore, defaultStateStoreConfig } from '@forge/state-store'
import { LocalModelService } from '@forge/local-model'
import type { ForgeConfig } from '@forge/types'
import type { ParsedArgs } from './commands/output.js'
import { getOption } from './commands/output.js'

export const LONG_HORIZON_MAX_WALL_CLOCK_MS = 8 * 60 * 60 * 1000
export const LONG_HORIZON_MAX_ITERATIONS = 10_000

export type StateMode = 'postgres' | 'file'

export interface PreflightOptions {
  command: 'init' | 'run' | 'resume' | 'repl'
  config: ForgeConfig
  parsed?: ParsedArgs
  requireLocalApproval?: boolean
}

export interface PreflightResult {
  ok: boolean
  fatal: boolean
  stateMode: StateMode
  degraded: boolean
  stateStore?: ForgeStateStore
  databaseUrl?: string
  localModel: {
    available: boolean
    approved: boolean
    detail: string
  }
  textLines: string[]
  warnings: string[]
  errors: string[]
}

export function requestedStateMode(parsed?: ParsedArgs): StateMode {
  const raw = getOption(parsed ?? emptyParsed(), 'state-mode') ?? getOption(parsed ?? emptyParsed(), 'state')
  return raw === 'file' ? 'file' : 'postgres'
}

export function longHorizonBudget(parsed?: ParsedArgs) {
  const hours = Number(getOption(parsed ?? emptyParsed(), 'hours'))
  const maxIters = Number(getOption(parsed ?? emptyParsed(), 'max-iterations'))
  return {
    maxWallClockMs: Number.isFinite(hours) && hours > 0
      ? Math.round(hours * 3600_000)
      : LONG_HORIZON_MAX_WALL_CLOCK_MS,
    maxIterations: Number.isFinite(maxIters) && maxIters > 0
      ? maxIters
      : LONG_HORIZON_MAX_ITERATIONS,
  }
}

export async function writeConnectionMetadata(config: ForgeConfig, databaseUrl?: string): Promise<string> {
  const stateDir = join(config.stateDir, 'state')
  await mkdir(stateDir, { recursive: true })
  const fp = join(stateDir, 'connection.json')
  await writeFile(fp, JSON.stringify({
    version: 1,
    stateMode: 'postgres',
    workDir: config.workDir,
    databaseUrl: databaseUrl ? redactPassword(databaseUrl) : null,
    source: databaseUrl ? 'FORGE_DATABASE_URL' : 'unset',
    updatedAt: new Date().toISOString(),
  }, null, 2), 'utf-8')
  return fp
}

export async function runPreflight(options: PreflightOptions): Promise<PreflightResult> {
  const parsed = options.parsed ?? emptyParsed()
  const stateMode = requestedStateMode(parsed)
  const warnings: string[] = []
  const errors: string[] = []
  const textLines: string[] = ['Forge preflight']
  let stateStore: ForgeStateStore | undefined
  const databaseUrl = process.env.FORGE_DATABASE_URL

  if (stateMode === 'file') {
    warnings.push('Degraded file state requested: Postgres durability, multi-agent safety, and typed resume are reduced.')
  } else if (!databaseUrl) {
    errors.push('Postgres is required for normal Forge runs, but FORGE_DATABASE_URL is not set.')
  } else {
    stateStore = new ForgeStateStore({ config: defaultStateStoreConfig(options.config.workDir, databaseUrl) })
    try {
      const health = await stateStore.init()
      if (health.schemaVersion !== health.requiredSchemaVersion) {
        errors.push(`Postgres schema v${health.schemaVersion} is not at required v${health.requiredSchemaVersion}. Run forge state migrate.`)
      }
    } catch (err) {
      errors.push(`Postgres state store is not ready: ${err instanceof Error ? err.message : String(err)}`)
      stateStore = undefined
    }
  }

  const allowNoLocal = booleanFlag(parsed, 'allow-no-local') || booleanFlag(parsed, 'yes') || booleanFlag(parsed, 'y')
  const shouldProbeLocal = errors.length === 0 && !(allowNoLocal && stateMode === 'file')
  const local = shouldProbeLocal
    ? await probeLocalModel(options.config)
    : {
      available: false,
      detail: errors.length > 0
        ? 'not checked because mandatory state preflight failed'
        : 'not checked because deterministic fallback was explicitly approved',
    }
  if (shouldProbeLocal && !local.available && options.requireLocalApproval && !allowNoLocal) {
    errors.push('Local model layer is unavailable. Re-run with --allow-no-local to approve deterministic fallbacks for this long autonomous run.')
  } else if (shouldProbeLocal && !local.available && allowNoLocal) {
    warnings.push('Local model layer unavailable; deterministic fallback compaction approved for this run.')
  }

  textLines.push(`  state:        ${stateMode === 'postgres' ? 'postgres' : 'file (degraded)'}`)
  textLines.push(`  database:     ${databaseUrl ? redactPassword(databaseUrl) : 'FORGE_DATABASE_URL not set'}`)
  textLines.push(`  state dir:    ${options.config.stateDir}`)
  textLines.push(`  work dir:     ${options.config.workDir}`)
  textLines.push(`  local model:  ${local.available ? 'available' : 'unavailable'} (${local.detail})`)
  const budget = longHorizonBudget(parsed)
  textLines.push(`  budget:       ${Math.round(budget.maxWallClockMs / 3600_000)}h / ${budget.maxIterations} iterations`)
  if (warnings.length > 0) textLines.push('', 'Warnings:', ...warnings.map((w) => `  ! ${w}`))
  if (errors.length > 0) {
    textLines.push('', 'Required action:', ...errors.map((e) => `  ✗ ${e}`))
    if (stateMode !== 'file') {
      textLines.push('  Use forge init/state doctor to configure Postgres, or pass --state-mode=file for an explicit degraded fallback.')
    }
  }

  const fatal = errors.length > 0
  return {
    ok: !fatal,
    fatal,
    stateMode,
    degraded: stateMode === 'file',
    stateStore,
    databaseUrl,
    localModel: { available: local.available, approved: local.available || allowNoLocal, detail: local.detail },
    textLines,
    warnings,
    errors,
  }
}

function booleanFlag(parsed: ParsedArgs, key: string): boolean {
  return parsed.options.get(key) === 'true'
}

async function probeLocalModel(config: ForgeConfig): Promise<{ available: boolean; detail: string }> {
  try {
    const service = new LocalModelService(config.localModel ?? { enabled: 'auto' })
    const available = await service.available()
    if (!available) return { available: false, detail: 'provider probe failed' }
    const summarize = await service.summarize({ taskId: 'preflight', content: 'Forge local model preflight.', label: 'preflight' })
    const embed = await service.embed({ taskId: 'preflight', texts: ['forge preflight'] })
    const fallback = summarize.provenance.fallbackUsed || embed.provenance.fallbackUsed
    return {
      available: !fallback,
      detail: fallback ? 'smoke test used fallback' : `smoke test ok, embed dim=${embed.dim}`,
    }
  } catch (err) {
    return { available: false, detail: err instanceof Error ? err.message : String(err) }
  }
}

function redactPassword(url: string): string {
  return url.replace(/(postgres(?:ql)?:\/\/[^:]+:)[^@]+(@)/, '$1***$2')
}

function emptyParsed(): ParsedArgs {
  return { args: [], positional: [], options: new Map(), json: false, text: true }
}
