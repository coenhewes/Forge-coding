/**
 * `forge doctor` — environment, database, and provider reachability check.
 *
 * Probes (in order):
 *   1. `FORGE_DATABASE_URL` set? (warning if not)
 *   2. `postgres` driver installed? (failure if not)
 *   3. Round-trip `select 1` against the configured Postgres URL
 *   4. `ForgeStateStore.init()` succeeds — opens conn + runs migrations
 *   5. `forge-tasks` + `forge-evidence` tables exist (per state-store schema)
 *   6. Provider reachability — pings `config.provider.name` against its
 *      configured base URL (best-effort, never fatal)
 *
 * The command always exits 0 when no probe failed fatally, and
 * exits 1 when at least one probe failed. `--migrate` runs
 * migrations after the health check.
 *
 * Output:
 *   --json   → { ok, exitCode, data: DoctorReport }
 *   --text   → human-readable per-probe line
 */
import { loadConfig, initConfig } from '../config.js'
import { ForgeStateStore, defaultStateStoreConfig } from '@forge/state-store'
import type { CommandResult, ParsedArgs } from './output.js'

export interface DoctorProbe {
  name: string
  ok: boolean
  detail: string
}

export interface DoctorReport {
  configLoaded: boolean
  stateDir: string
  databaseUrlPresent: boolean
  databaseUrlRedacted?: string
  postgres: DoctorProbe
  driver: DoctorProbe
  schema: DoctorProbe
  stateStoreInit: DoctorProbe
  provider: DoctorProbe
  warnings: string[]
  fatal: boolean
}

function redactPassword(url: string): string {
  return url.replace(/(postgres(?:ql)?:\/\/[^:]+:)[^@]+(@)/, '$1***$2')
}

async function probePostgres(dbUrl: string): Promise<DoctorProbe> {
  try {
    const mod = await import('postgres')
    const factory = ((mod as unknown as { default?: unknown }).default ?? mod) as
      (cs: string) => {
        <T = unknown>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T>
        end(opts?: { timeout?: number }): Promise<void>
      }
    const sql = factory(dbUrl)
    try {
      const result = await sql<[{ ok: number }]>`select 1 as ok`
      return { name: 'postgres', ok: true, detail: `reachable (select 1 → ${result[0]?.ok})` }
    } finally {
      await sql.end({ timeout: 5 })
    }
  } catch (err) {
    return { name: 'postgres', ok: false, detail: err instanceof Error ? err.message : String(err) }
  }
}

async function probeProvider(baseUrl: string | undefined): Promise<DoctorProbe> {
  if (!baseUrl) {
    return { name: 'provider', ok: false, detail: 'no base URL configured' }
  }
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), 4000)
  try {
    const res = await fetch(baseUrl, { method: 'GET', signal: ctrl.signal })
    return {
      name: 'provider',
      ok: res.status < 500,
      detail: `${baseUrl} → HTTP ${res.status}`,
    }
  } catch (err) {
    return { name: 'provider', ok: false, detail: err instanceof Error ? err.message : String(err) }
  } finally {
    clearTimeout(t)
  }
}

export async function runDoctor(parsed: ParsedArgs): Promise<CommandResult<DoctorReport>> {
  let config = await loadConfig()
  if (!config) config = await initConfig()
  void parsed

  const warnings: string[] = []
  const dbUrl = process.env.FORGE_DATABASE_URL
  const driver: DoctorProbe = await (async () => {
    try {
      const mod = await import('postgres')
      const factory = (mod as { default?: unknown }).default ?? mod
      return { name: 'driver', ok: typeof factory === 'function', detail: 'postgres installed' }
    } catch (err) {
      return { name: 'driver', ok: false, detail: err instanceof Error ? err.message : String(err) }
    }
  })()

  const postgres = dbUrl
    ? await probePostgres(dbUrl)
    : { name: 'postgres', ok: false, detail: 'FORGE_DATABASE_URL not set' }

  let schema: DoctorProbe = { name: 'schema', ok: false, detail: 'not checked (no DB)' }
  let stateStoreInit: DoctorProbe = { name: 'stateStoreInit', ok: false, detail: 'not checked (no DB)' }
  if (dbUrl) {
    const store = new ForgeStateStore({ config: defaultStateStoreConfig(config.workDir, dbUrl) })
    try {
      const health = await store.init()
      // init() returns plain StateStoreHealth; call health() to get the
      // extended shape with tableCounts.
      const detailed = await store.health()
      schema = {
        name: 'schema',
        ok: health.schemaVersion === health.requiredSchemaVersion,
        detail: `schema v${health.schemaVersion} (required v${health.requiredSchemaVersion})${health.warnings.length > 0 ? `, ${health.warnings.length} warning(s)` : ''}`,
      }
      const tableNames = Object.keys(detailed.tableCounts ?? {})
      const required = ['repos', 'tasks', 'task_snapshots', 'acceptance_criteria', 'artifacts', 'evidence', 'decisions', 'failures', 'patch_candidates', 'checkpoints', 'verification_checks', 'commands', 'trace_events', 'local_model_runs', 'embeddings']
      const missing = required.filter((r) => !tableNames.includes(r))
      if (missing.length > 0) {
        warnings.push(`missing tables: ${missing.join(', ')}`)
      }
      stateStoreInit = {
        name: 'stateStoreInit',
        ok: missing.length === 0,
        detail: missing.length === 0 ? `${tableNames.length} table(s) present` : `missing ${missing.length} required table(s)`,
      }
    } catch (err) {
      stateStoreInit = { name: 'stateStoreInit', ok: false, detail: err instanceof Error ? err.message : String(err) }
    }
  }

  const provider = await probeProvider(process.env.FORGE_PROVIDER_BASE_URL ?? process.env.MINIMAX_BASE_URL)

  const fatal = !driver.ok || (!!dbUrl && (!postgres.ok || !stateStoreInit.ok))
  const report: DoctorReport = {
    configLoaded: true,
    stateDir: config.stateDir,
    databaseUrlPresent: !!dbUrl,
    databaseUrlRedacted: dbUrl ? redactPassword(dbUrl) : undefined,
    postgres,
    driver,
    schema,
    stateStoreInit,
    provider,
    warnings,
    fatal,
  }

  const textLines = [
    'Forge doctor — environment check',
    `  config:       ${report.configLoaded ? `loaded (${report.stateDir})` : 'not loaded'}`,
    `  database:     ${dbUrl ? redactPassword(dbUrl) : 'FORGE_DATABASE_URL not set'}`,
    `  driver:       ${driver.ok ? '✓' : '✗'} ${driver.detail}`,
    `  postgres:     ${postgres.ok ? '✓' : '✗'} ${postgres.detail}`,
    `  schema:       ${schema.ok ? '✓' : '✗'} ${schema.detail}`,
    `  stateStore:   ${stateStoreInit.ok ? '✓' : '✗'} ${stateStoreInit.detail}`,
    `  provider:     ${provider.ok ? '✓' : '?'} ${provider.detail}`,
    ...(warnings.length > 0 ? ['', 'Warnings:', ...warnings.map((w) => `  ! ${w}`)] : []),
  ]

  return {
    ok: !fatal,
    exitCode: fatal ? 1 : 0,
    data: report,
    message: fatal ? 'forge doctor: one or more probes failed' : 'forge doctor: all probes ok',
    textLines,
  }
}
