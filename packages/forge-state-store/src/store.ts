/**
 * ForgeStateStore — the public facade for Forge's durable Postgres
 * state store.
 *
 * Responsibilities:
 *   - Own the postgres.js connection lifecycle.
 *   - Apply migrations (`runMigrations`).
 *   - Expose typed repositories via `store.repos.*`.
 *   - Wrap transactions with `store.tx(...)` so callers can write
 *     typed state and emit trace events atomically. Trace events are
 *     **co-transactional** with the writes that triggered them — if
 *     the transaction rolls back, the trace rolls back with it.
 *   - Run health checks, backup/restore, pg_dump-style export/import,
 *     and the file-state import compatibility shim.
 *
 * State changes are durable; trace events are co-transactional.
 */
import { spawn } from 'node:child_process'
import { mkdir, readdir, readFile, writeFile, unlink, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Sql } from 'postgres'
import type {
  ArtifactRecord,
  ContextSlice,
  DurableWriteReceipt,
  StateStoreActor,
  StateStoreConfig,
  StateStoreHealth,
} from '@forge/types'
import { ArtifactStore } from './artifact-store.js'
import { MIGRATIONS, REQUIRED_SCHEMA_VERSION, fullSchemaSql } from './schema.js'
import { Repos, TraceEventInput } from './repos/index.js'
import type { ArtifactWithBytes } from './artifact-store.js'

export interface ForgeStateStoreOptions {
  config: StateStoreConfig
}

/** What `store.tx(...)` passes to the callback. */
export interface TxContext {
  /** Bag of every typed repository, all bound to this transaction. */
  repos: Repos
  /** Insert a trace event row inside this transaction. */
  trace(event: TraceEventInput): Promise<{ id: string; createdAt: string }>
}

/**
 * Default state directory used when no `stateDir` is supplied to the
 * `importFromFileState(...)` shim. Mirrors `~/.forge/state`.
 */
export function defaultStateDir(): string {
  return join(process.env.HOME ?? '/tmp', '.forge', 'state')
}

export function defaultStateStoreConfig(rootDir: string, connectionString?: string): StateStoreConfig {
  return {
    connectionString,
    schemaVersion: REQUIRED_SCHEMA_VERSION,
    artifactsDir: join(rootDir, '.forge', 'artifacts'),
    localFirst: true,
  }
}

/**
 * Internal: lazily import the `postgres` driver so the package stays
 * usable in environments that haven't installed it. Used both for the
 * migration runner and for the live connection the facade owns.
 */
async function loadPostgres(): Promise<(cs: string) => Sql> {
  const mod = await import('postgres').catch(() => {
    throw new Error(
      "ForgeStateStore requires the 'postgres' package. Install it (pnpm add postgres) and retry.",
    )
  })
  const factory = (mod as { default?: unknown }).default ?? mod
  if (typeof factory !== 'function') {
    throw new Error("Failed to load the 'postgres' driver: default export is not callable.")
  }
  return factory as (cs: string) => Sql
}

/**
 * Construct a stub `Sql` that throws on every query. Used to seed
 * `ForgeStateStore.repos` in the constructor so the property is
 * always defined, while still surfacing "call init() first" for
 * any repository call before the connection is open.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeStubSql(): any {
  const msg = "ForgeStateStore has no open Postgres connection. Call init() first, or pass a connection string to the method you're using."
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handler: ProxyHandler<any> = {
    get() {
      throw new Error(msg)
    },
    apply() {
      throw new Error(msg)
    },
  }
  return new Proxy(function () { throw new Error(msg) }, handler)
}

export class ForgeStateStore {
  /** Bag of typed repositories bound to the live connection (autocommit). */
  readonly repos: Repos
  /** Lazy: only created once `init()` runs. */
  private artifactStore?: ArtifactStore
  private sql?: Sql
  /** In-memory mirror kept for back-compat with the existing surface. */
  private records = new Map<string, StateRecord[]>()
  private artifacts = new Map<string, ArtifactRecord>()

  constructor(private options: ForgeStateStoreOptions) {
    // Build a placeholder `repos` bag pointing at a stub client. We
    // can't open the Postgres connection in the constructor (we may
    // not have `config.connectionString` yet, and we don't want to
    // throw here — `runMigrations()` is the right surface to open the
    // connection on demand). The real bag replaces this one the
    // first time `init()` or `runMigrations()` opens a connection.
    this.repos = new Repos(makeStubSql())
  }

  get config(): StateStoreConfig {
    return this.options.config
  }

  /**
   * Open the Postgres connection and apply any pending migrations.
   * Safe to call repeatedly — `runMigrations` is idempotent.
   */
  async init(): Promise<StateStoreHealth> {
    await mkdir(this.options.config.artifactsDir, { recursive: true })
    if (!this.options.config.connectionString) {
      throw new Error(
        'ForgeStateStore.init() requires config.connectionString. ' +
          'Set FORGE_DATABASE_URL or pass it to defaultStateStoreConfig.',
      )
    }
    const postgres = await loadPostgres()
    const sql = postgres(this.options.config.connectionString)
    this.sql = sql
    // Replace the lazily-created Repos bag with one bound to the live
    // connection so callers see the same instance.
    this.replaceRepos(sql)
    await this.runMigrations(this.options.config.connectionString)
    return this.health()
  }

  /**
   * Replace the `repos` field with a `Repos` bag bound to the
   * supplied connection. Used both by `init()` and by the `tx(...)`
   * wrapper to give the callback a transaction-scoped bag.
   */
  private replaceRepos(sql: Sql): void {
    Object.defineProperty(this, 'repos', {
      value: new Repos(sql),
      writable: true,
      configurable: true,
    })
  }

  /** Throws if no connection has been opened yet via `init()`. */
  private getOrThrow(): Sql {
    if (!this.sql) {
      throw new Error(
        'ForgeStateStore has no open Postgres connection. Call init() first, ' +
          'or use store.tx() with an explicit connection string.',
      )
    }
    return this.sql
  }

  schemaSql(): string {
    return fullSchemaSql()
  }

  migrations() {
    return [...MIGRATIONS]
  }

  /**
   * Apply any unapplied migrations to a Postgres database. Reads
   * `MIGRATIONS` from `schema.ts`, applies versions that are not yet
   * recorded in `schema_migrations`, and returns the versions that
   * were applied. Each migration runs inside its own transaction so
   * partial application is impossible.
   */
  async runMigrations(connectionStringOverride?: string): Promise<number[]> {
    const connectionString = connectionStringOverride ?? this.options.config.connectionString
    if (!connectionString) {
      throw new Error(
        'runMigrations() requires a Postgres connection string; pass one explicitly or set config.connectionString.',
      )
    }
    const postgres = await loadPostgres()
    const sql = postgres(connectionString)
    try {
      let appliedRows: { version: number }[]
      try {
        appliedRows = await sql<[{ version: number }]>`
          select version from schema_migrations
        `
      } catch (err) {
        if (isMissingRelationError(err, 'schema_migrations')) {
          appliedRows = []
        } else {
          throw err
        }
      }
      const appliedSet = new Set(appliedRows.map((r) => r.version))
      const appliedNow: number[] = []
      for (const migration of MIGRATIONS) {
        if (appliedSet.has(migration.version)) continue
        const statements = splitSqlStatements(migration.sql)
        await sql.begin(async (tx) => {
          for (const stmt of statements) {
            await tx.unsafe(stmt)
          }
          await tx`
            insert into schema_migrations (version, name)
            values (${migration.version}, ${migration.name})
            on conflict (version) do nothing
          `
        })
        appliedNow.push(migration.version)
      }
      return appliedNow
    } finally {
      await sql.end({ timeout: 5 })
    }
  }

  /**
   * Run `fn` inside a Postgres transaction. The callback gets a
   * `TxContext` with the typed repositories AND a `trace` helper
   * that writes to `trace_events` inside the same transaction.
   *
   * If `fn` throws, postgres.js rolls back the transaction — and
   * every trace event emitted through `tx.trace(...)` rolls back
   * with it. This is the co-transactional guarantee.
   */
  async tx<T>(fn: (ctx: TxContext) => Promise<T>): Promise<T> {
    if (!this.sql) throw new Error('ForgeStateStore.init() must be called before tx().')
    // `sql.begin` returns `Promise<UnwrapPromiseArray<T>>` to also accept
    // arrays of statements; we always pass a single-returning callback,
    // so the cast is safe.
    return (await this.sql.begin(async (txSql) => {
      const repos = new Repos(txSql as unknown as never)
      // Per-transaction cache: task_id → repo_id, to backfill trace events
      // whose caller omitted the repo id without re-querying every time.
      const traceRepoCache = new Map<string, string>()
      const ctx: TxContext = {
        repos,
        trace: async (event) => {
          // trace_events.repo_id is NOT NULL. Callers don't always have the
          // repo id handy (e.g. the belief store emits events keyed only by
          // task), so resolve it from the task row within this same
          // transaction when it's missing. One lookup, cached per tx.
          let repoId = event.repoId ?? null
          if (!repoId && event.taskId) {
            repoId = traceRepoCache.get(event.taskId) ?? null
            if (!repoId) {
              const task = await repos.tasks.get(event.taskId)
              repoId = task?.repoId ?? null
              if (repoId) traceRepoCache.set(event.taskId, repoId)
            }
          }
          const row = await repos.trace.insert({
            id: randomUUID(),
            taskId: event.taskId ?? null,
            repoId,
            eventType: event.type,
            actor: event.actor ?? 'system',
            summary: event.summary,
            payload: event.payload ?? {},
          })
          return { id: row.id, createdAt: row.createdAt }
        },
      }
      return fn(ctx)
    })) as T
  }

  /** `pg_dump`-style SQL export to a file. */
  async export(path: string): Promise<void> {
    if (!this.options.config.connectionString) {
      throw new Error('export() requires a configured connection string.')
    }
    await mkdir(dirname(path), { recursive: true })
    await new Promise<void>((resolve, reject) => {
      const args = [
        ...parsePgUrlArgs(this.options.config.connectionString!),
        '--no-owner',
        '--no-privileges',
        '--file',
        path,
      ]
      const child = spawn('pg_dump', args, { stdio: ['ignore', 'inherit', 'pipe'] })
      let stderr = ''
      child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()))
      child.on('error', reject)
      child.on('exit', (code) => {
        if (code === 0) resolve()
        else reject(new Error(`pg_dump exited with code ${code}: ${stderr}`))
      })
    })
  }

  /** `psql`-style SQL import from a file produced by `export(...)`. */
  async import(path: string): Promise<void> {
    if (!this.options.config.connectionString) {
      throw new Error('import() requires a configured connection string.')
    }
    if (!(await fileExists(path))) {
      throw new Error(`import(): no such file ${path}`)
    }
    await new Promise<void>((resolve, reject) => {
      const args = [
        ...parsePgUrlArgs(this.options.config.connectionString!),
        '--no-owner',
        '--no-privileges',
        '--file',
        path,
      ]
      const child = spawn('psql', args, { stdio: ['ignore', 'inherit', 'pipe'] })
      let stderr = ''
      child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()))
      child.on('error', reject)
      child.on('exit', (code) => {
        if (code === 0) resolve()
        else reject(new Error(`psql exited with code ${code}: ${stderr}`))
      })
    })
  }

  /**
   * Backup is currently a thin alias for `export(...)` — Postgres
   * `pg_dump` output is the canonical portable backup format and
   * restoring is `import(path)`.
   */
  async backup(path: string): Promise<void> {
    await this.export(path)
  }

  async restore(path: string): Promise<void> {
    await this.import(path)
  }

  /**
   * Compatibility shim — read `.forge/tasks/<taskId>/*.json` files
   * (written by the legacy `TaskStateEngine` in `@forge/state`) and
   * insert them into Postgres. This is the migration path called out
   * in the plan ("keep existing `.forge` readers as migration/import
   * compatibility only").
   *
   * The shim is intentionally narrow:
   *   - One `repos` row (root_path = absolute stateDir).
   *   - One `tasks` row per `*.json` file.
   *   - Acceptance criteria, files-touched, commands-run, and
   *     test-run become trace events (so the existing audit trail
   *     is preserved without inventing new tables).
   *
   * Caller can pass an `actor` to attribute the import to a user.
   */
  async importFromFileState(stateDir: string, actor: StateStoreActor = 'system'): Promise<{
    imported: number
    repoId: string
  }> {
    if (!this.sql) throw new Error('ForgeStateStore.init() must be called before importFromFileState.')
    const repoId = randomUUID()
    const tasksDir = join(stateDir, 'tasks')

    let taskFiles: string[] = []
    try {
      const entries = await readdir(tasksDir, { withFileTypes: true })
      taskFiles = entries
        .filter((e) => e.isFile() && e.name.endsWith('.json'))
        .map((e) => e.name)
    } catch (err) {
      // Missing dir → nothing to import.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return { imported: 0, repoId }
      }
      throw err
    }

    let imported = 0
    for (const filename of taskFiles) {
      const raw = await readFile(join(tasksDir, filename), 'utf-8')
      const parsed = JSON.parse(raw) as Record<string, unknown>
      const taskId = String(parsed.taskId ?? filename.replace(/\.json$/, ''))
      const title = typeof parsed.title === 'string' ? parsed.title : String(parsed.originalRequest ?? taskId)
      const originalRequest = String(parsed.originalRequest ?? '')
      const status = String(parsed.status ?? 'pending')
      const mode = String(parsed.mode ?? 'implement')
      const currentSummary = typeof parsed.currentSummary === 'string' ? parsed.currentSummary : null
      const nextAction = typeof parsed.nextAction === 'string' ? parsed.nextAction : null

      await this.tx(async (ctx) => {
        await ctx.repos.repos.insert({
          id: repoId,
          rootPath: stateDir,
          name: stateDir.split('/').pop() ?? 'imported',
          currentBranch: null,
          payload: { source: 'file-state-import' },
        })
        await ctx.repos.tasks.insert({
          id: taskId,
          repoId,
          title,
          originalRequest,
          interpretedGoal: typeof parsed.currentInterpretation === 'string' ? parsed.currentInterpretation : null,
          status,
          mode,
          activeBranch: null,
          activePatchCandidateId: null,
          currentSummary,
          nextAction,
          payload: {
            importedFrom: 'file-state',
            acceptanceCriteria: parsed.acceptanceCriteria ?? [],
            filesTouched: parsed.filesTouched ?? [],
            commandsRun: parsed.commandsRun ?? [],
            testsRun: parsed.testsRun ?? [],
            failuresEncountered: parsed.failuresEncountered ?? [],
            decisionsMade: parsed.decisionsMade ?? [],
            risks: parsed.risks ?? [],
            failedHypotheses: parsed.failedHypotheses ?? [],
            verificationStatus: parsed.verificationStatus ?? {},
            patchCandidates: parsed.patchCandidates ?? [],
          },
        })
        await ctx.repos.taskSnapshots.insert({
          id: randomUUID(),
          taskId,
          snapshotType: 'imported_from_file_state',
          summary: `Imported from ${join(stateDir, 'tasks', filename)}`,
          payload: parsed,
        })
        await ctx.trace({
          type: 'task_imported_from_file_state',
          taskId,
          repoId,
          actor,
          summary: `Imported task ${taskId} from ${stateDir}`,
          payload: { source: stateDir, filename },
        })
        imported += 1
      })
    }
    return { imported, repoId }
  }

  /** Returns the artifact store, creating it lazily. */
  artifactStoreOrThrow(): ArtifactStore {
    if (!this.artifactStore) {
      this.artifactStore = new ArtifactStore({
        rootDir: this.options.config.artifactsDir,
        artifacts: this.repos.artifacts,
      })
    }
    return this.artifactStore
  }

  /** Convenience: write an artifact using the bound ArtifactStore. */
  async writeArtifact(
    opts: {
      taskId?: string
      artifactType: string
      relativePath: string
      mime?: string
      summary?: string
      payload?: Record<string, unknown>
    },
    content: string | Uint8Array,
  ): Promise<ArtifactWithBytes> {
    return this.artifactStoreOrThrow().write(opts, content)
  }

  /** Convenience: read an artifact (metadata + bytes) by id. */
  async getArtifact(id: string): Promise<ArtifactWithBytes | undefined> {
    return this.artifactStoreOrThrow().get(id)
  }

  /** Find artifact bytes on disk that have no matching metadata row. */
  async orphanArtifacts(): Promise<{ path: string; sizeBytes: number | null }[]> {
    return this.artifactStoreOrThrow().orphans()
  }

  /**
   * Health snapshot for the TUI / status endpoints. Counts the rows
   * in the major tables so the dashboard can render a top-level
   * "30 / 30 tables, 14 tasks, 412 evidence rows" view without an
   * extra round-trip per table.
   */
  async health(): Promise<StateStoreHealth & {
    connectionCount?: number
    tableCounts?: Record<string, number>
  }> {
    const artifactStoreWritable = await this.artifactStoreOrThrow().isWritable()
    let postgresReachable = false
    if (this.sql) {
      postgresReachable = await isAlive(this.sql)
    }
    const warnings: string[] = []
    if (!postgresReachable) warnings.push('Postgres is not reachable.')
    if (!artifactStoreWritable) warnings.push('Artifact store is not writable.')

    let tableCounts: Record<string, number> | undefined
    let connectionCount: number | undefined
    if (postgresReachable && this.sql) {
      try {
        tableCounts = await countTables(this.sql)
        const c = await this.sql<{ count: number }[]>`select count(*)::int as count from pg_stat_activity`
        connectionCount = c[0]?.count ?? 0
      } catch (err) {
        warnings.push(`Health counts failed: ${(err as Error).message}`)
      }
    }

    return {
      ok: postgresReachable && artifactStoreWritable,
      schemaVersion: this.options.config.schemaVersion,
      requiredSchemaVersion: REQUIRED_SCHEMA_VERSION,
      postgresReachable,
      artifactStoreWritable,
      warnings,
      connectionCount,
      tableCounts,
    }
  }

  async migrate(): Promise<{ requiredSchemaVersion: number; migrations: number[]; sql: string }> {
    return {
      requiredSchemaVersion: REQUIRED_SCHEMA_VERSION,
      migrations: MIGRATIONS.map((m) => m.version),
      sql: fullSchemaSql(),
    }
  }

  /**
   * Retention policy placeholder: never prune active evidence until
   * PR/task is inactive. Returns a count of how many rows exist
   * across the major tables; pruning itself is a no-op for this
   * track (retention policy is owned by Track 4 sessions layer).
   */
  async prune(): Promise<{ pruned: number; preserved: number }> {
    if (!this.sql) {
      const preserved = [...this.records.values()].reduce((sum, r) => sum + r.length, 0)
      return { pruned: 0, preserved }
    }
    const counts = await countTables(this.sql)
    const preserved = Object.values(counts).reduce((sum, n) => sum + n, 0)
    return { pruned: 0, preserved }
  }

  /**
   * Back-compat with the original engine-style API. Records are
   * stored in an in-memory map (kept for unit tests that exercise
   * the legacy surface). New code should use `store.repos.*`
   * directly.
   */
  async writeRecord(
    kind: string,
    payload: Record<string, unknown>,
    options?: { taskId?: string; actor?: StateStoreActor },
  ): Promise<DurableWriteReceipt> {
    const now = new Date().toISOString()
    const record: StateRecord = {
      id: randomUUID(),
      kind,
      taskId: options?.taskId,
      actor: options?.actor ?? 'system',
      payload,
      createdAt: now,
      updatedAt: now,
    }
    const list = this.records.get(kind) ?? []
    list.push(record)
    this.records.set(kind, list)
    const traceEventId = randomUUID()
    const traces = this.records.get('trace_events') ?? []
    traces.push({
      id: traceEventId,
      kind: 'trace_events',
      taskId: options?.taskId,
      actor: options?.actor ?? 'system',
      payload: { eventType: 'state_write', kind, recordId: record.id },
      createdAt: now,
      updatedAt: now,
    })
    this.records.set('trace_events', traces)
    return { id: record.id, kind, actor: record.actor, traceEventId, createdAt: now }
  }

  async listRecords(kind: string, taskId?: string): Promise<StateRecord[]> {
    const records = this.records.get(kind) ?? []
    return taskId ? records.filter((r) => r.taskId === taskId) : [...records]
  }

  async latestRecord(kind: string, taskId?: string): Promise<StateRecord | undefined> {
    const records = await this.listRecords(kind, taskId)
    return records.at(-1)
  }

  async contextSlice<T>(
    capability: string,
    data: T,
    options?: { taskId?: string; sources?: string[]; warnings?: string[]; stale?: boolean; missing?: string[]; relevanceScore?: number },
  ): Promise<ContextSlice<T>> {
    return {
      capability,
      taskId: options?.taskId,
      data,
      sources: options?.sources ?? [],
      warnings: options?.warnings ?? [],
      stale: options?.stale ?? false,
      missing: options?.missing ?? [],
      relevanceScore: options?.relevanceScore,
    }
  }

  /** Release the postgres connection. Idempotent. */
  async close(): Promise<void> {
    if (!this.sql) return
    try {
      await this.sql.end({ timeout: 5 })
    } finally {
      this.sql = undefined
      this.artifactStore = undefined
    }
  }
}

export interface StateRecord {
  id: string
  kind: string
  taskId?: string
  actor: StateStoreActor
  payload: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

/* ---------------------------------------------------------------- *
 *  Internal helpers
 * ---------------------------------------------------------------- */

function isMissingRelationError(err: unknown, relation: string): boolean {
  if (!err || typeof err !== 'object') return false
  const code = (err as { code?: unknown }).code
  const message = (err as { message?: unknown }).message
  if (code !== '42P01') return false
  if (typeof message !== 'string') return true
  return message.includes(`"${relation}"`)
}

function splitSqlStatements(input: string): string[] {
  const out: string[] = []
  let buf = ''
  let inSingle = false
  let inDouble = false
  let inLineComment = false
  let inBlockComment = false
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]
    const next = input[i + 1]
    if (inLineComment) {
      if (ch === '\n') inLineComment = false
      buf += ch
      continue
    }
    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false
        buf += '*/'
        i++
        continue
      }
      buf += ch
      continue
    }
    if (!inSingle && !inDouble) {
      if (ch === '-' && next === '-') {
        inLineComment = true
        buf += '--'
        i++
        continue
      }
      if (ch === '/' && next === '*') {
        inBlockComment = true
        buf += '/*'
        i++
        continue
      }
    }
    if (!inDouble && ch === "'" && input[i - 1] !== '\\') {
      inSingle = !inSingle
    } else if (!inSingle && ch === '"' && input[i - 1] !== '\\') {
      inDouble = !inDouble
    }
    if (ch === ';' && !inSingle && !inDouble) {
      const trimmed = buf.trim()
      if (trimmed.length > 0) out.push(trimmed)
      buf = ''
      continue
    }
    buf += ch
  }
  const tail = buf.trim()
  if (tail.length > 0) out.push(tail)
  return out
}

async function isAlive(sql: Sql): Promise<boolean> {
  try {
    await sql`select 1 as alive`
    return true
  } catch {
    return false
  }
}

async function countTables(sql: Sql): Promise<Record<string, number>> {
  // `information_schema.tables` respects search_path directly, which is
  // easier to reason about than `pg_stat_user_tables.schemaname =
  // current_schema()` (those two can disagree if Postgres cached the
  // old schema in the stats view). We pair each table with
  // `pg_stat_user_tables.n_live_tup` when available so we still get
  // approximate row counts.
  const rows = await sql<{ table_name: string; n_live_tup: number | null }[]>`
    select t.table_name, s.n_live_tup
    from information_schema.tables t
    left join pg_stat_user_tables s
      on s.schemaname = t.table_schema and s.relname = t.table_name
    where t.table_schema = current_schema()
      and t.table_type = 'BASE TABLE'
  `
  const counts: Record<string, number> = {}
  for (const r of rows) counts[r.table_name] = Number(r.n_live_tup ?? 0)
  return counts
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/**
 * Convert a Postgres URL into the argv shape `pg_dump` / `psql` expect.
 * The CLI accepts either `--dbname=URL` (single arg) or the discrete
 * `--host --port --user --dbname` flags. We use the former so we don't
 * have to parse the URL ourselves.
 */
function parsePgUrlArgs(url: string): string[] {
  return [`--dbname=${url}`]
}

// Re-exports so the index can pick them up.
export { ArtifactStore }
export type { ArtifactStoreOptions, ArtifactWithBytes } from './artifact-store.js'
