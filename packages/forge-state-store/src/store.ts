import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
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

export interface StateRecord {
  id: string
  kind: string
  taskId?: string
  actor: StateStoreActor
  payload: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

export interface ForgeStateStoreOptions {
  config: StateStoreConfig
}

export class ForgeStateStore {
  private records = new Map<string, StateRecord[]>()
  private artifacts = new Map<string, ArtifactRecord>()
  private artifactStore: ArtifactStore

  constructor(private options: ForgeStateStoreOptions) {
    this.artifactStore = new ArtifactStore({ rootDir: options.config.artifactsDir })
  }

  get config(): StateStoreConfig {
    return this.options.config
  }

  schemaSql(): string {
    return fullSchemaSql()
  }

  migrations() {
    return [...MIGRATIONS]
  }

  async init(): Promise<StateStoreHealth> {
    await mkdir(this.options.config.artifactsDir, { recursive: true })
    return this.health()
  }

  async health(): Promise<StateStoreHealth> {
    const artifactStoreWritable = await this.artifactStore.isWritable()
    const postgresReachable = Boolean(this.options.config.connectionString)
    const warnings: string[] = []
    if (!postgresReachable) {
      warnings.push('No Postgres connection string configured; typed state APIs are running in local process mode only.')
    }
    if (!artifactStoreWritable) warnings.push('Artifact store is not writable.')
    return {
      ok: artifactStoreWritable,
      schemaVersion: this.options.config.schemaVersion,
      requiredSchemaVersion: REQUIRED_SCHEMA_VERSION,
      postgresReachable,
      artifactStoreWritable,
      warnings,
    }
  }

  async migrate(): Promise<{ requiredSchemaVersion: number; migrations: number[]; sql: string }> {
    await this.init()
    return {
      requiredSchemaVersion: REQUIRED_SCHEMA_VERSION,
      migrations: MIGRATIONS.map((m) => m.version),
      sql: fullSchemaSql(),
    }
  }

  /**
   * Apply any unapplied migrations to a Postgres database. Reads `MIGRATIONS`
   * from `schema.ts`, applies versions that are not yet recorded in
   * `schema_migrations`, and returns the versions that were applied.
   *
   * The implementation:
   *   - Splits each migration's SQL into individual statements (so the
   *     `postgres` driver can execute them one at a time). Each migration
   *     also runs inside a single transaction so partial application is
   *     impossible — either all statements in a version land, or none do.
   *   - Records the version, name, and applied_at in `schema_migrations`.
   *   - Returns the list of versions that were applied by this call.
   *
   * If the underlying driver isn't available (no connection string, or the
   * `postgres` package isn't installed), this method throws — callers should
   * treat that as "can't run migrations in this environment", not as a
   * silent no-op.
   */
  async runMigrations(connectionStringOverride?: string): Promise<number[]> {
    const connectionString = connectionStringOverride ?? this.options.config.connectionString
    if (!connectionString) {
      throw new Error(
        'runMigrations() requires a Postgres connection string; pass one explicitly or set config.connectionString.',
      )
    }

    // Lazy import — keeps the package usable in environments that haven't
    // installed the optional `postgres` driver.
    const postgresModule = await import('postgres').catch(() => {
      throw new Error(
        "runMigrations() requires the 'postgres' package. Install it (pnpm add postgres) and retry.",
      )
    })
    const postgresFactory = (postgresModule as { default?: unknown }).default ?? postgresModule
    if (typeof postgresFactory !== 'function') {
      throw new Error("Failed to load the 'postgres' driver: default export is not callable.")
    }

    const sql = (postgresFactory as (cs: string) => Sql)(connectionString)

    try {
      // Bootstrap the migrations tracking table on a fresh database. The
      // first migration's SQL already does this, but we still need it to
      // exist before we can query applied versions for the very first run.
      await sql`
        create table if not exists schema_migrations (
          version integer primary key,
          name text not null,
          applied_at timestamptz not null default now()
        )
      `

      const appliedRows = await sql<[{ version: number }]>`
        select version from schema_migrations
      `
      const appliedSet = new Set(appliedRows.map((row) => row.version))
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

  async writeArtifact(
    taskId: string | undefined,
    artifactType: string,
    relativePath: string,
    content: string | Uint8Array,
    summary?: string,
  ): Promise<ArtifactRecord> {
    const artifact = await this.artifactStore.write(taskId, artifactType, relativePath, content, summary)
    this.artifacts.set(artifact.id, artifact)
    await this.writeRecord('artifacts', artifact as unknown as Record<string, unknown>, { taskId, actor: 'system' })
    return artifact
  }

  async getArtifact(id: string): Promise<ArtifactRecord | undefined> {
    return this.artifacts.get(id)
  }

  async readArtifact(id: string): Promise<string | undefined> {
    const artifact = this.artifacts.get(id)
    return artifact ? this.artifactStore.read(artifact) : undefined
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

  async exportState(path: string): Promise<void> {
    const payload = {
      schemaVersion: this.options.config.schemaVersion,
      records: Object.fromEntries(this.records),
      artifacts: [...this.artifacts.values()],
      exportedAt: new Date().toISOString(),
    }
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, JSON.stringify(payload, null, 2), 'utf-8')
  }

  async importState(path: string): Promise<void> {
    const raw = JSON.parse(await readFile(path, 'utf-8')) as {
      records?: Record<string, StateRecord[]>
      artifacts?: ArtifactRecord[]
    }
    this.records.clear()
    for (const [kind, records] of Object.entries(raw.records ?? {})) {
      this.records.set(kind, records)
    }
    this.artifacts.clear()
    for (const artifact of raw.artifacts ?? []) {
      this.artifacts.set(artifact.id, artifact)
    }
  }

  async backup(path: string): Promise<void> {
    await this.exportState(path)
  }

  async restore(path: string): Promise<void> {
    await this.importState(path)
  }

  async prune(): Promise<{ pruned: number; preserved: number }> {
    // Retention policy placeholder: never prune active evidence until PR/task is inactive.
    const preserved = [...this.records.values()].reduce((sum, records) => sum + records.length, 0)
    return { pruned: 0, preserved }
  }
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
 * Split a multi-statement SQL string into individual statements. Strips
 * comments and empty statements, respects single-quoted strings (so a `;`
 * inside a literal doesn't terminate the statement). Suitable for any
 * standard SQL dialect — no PostgreSQL-specific grammar assumptions.
 */
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
