import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import postgres from 'postgres'
import { randomUUID } from 'node:crypto'
import {
  ForgeStateStore,
  defaultStateStoreConfig,
  MIGRATIONS,
} from '@forge/state-store'
import { tmpStateDir, cleanup } from './helpers.js'

const DATABASE_URL = process.env.FORGE_DATABASE_URL
const HAS_DB = Boolean(DATABASE_URL)

// Tables we expect runMigrations() to create, derived from the migration
// SQL itself. We assert at least the documented baseline tables exist after
// a fresh apply, instead of pinning an exact count that can drift as new
// tables land in schema.ts.
const EXPECTED_TABLES = [
  'schema_migrations',
  'repos',
  'tasks',
  'task_snapshots',
  'acceptance_criteria',
  'repo_nodes',
  'repo_edges',
  'domains',
  'beliefs',
  'hypotheses',
  'claims',
  'artifacts',
  'evidence',
  'claim_evidence_links',
  'failures',
  'decisions',
  'probes',
  'patch_candidates',
  'checkpoints',
  'verification_checks',
  'verification_actions',
  'verification_action_claim_links',
  'verification_action_scores',
  'verification_history',
  'commands',
  'trace_events',
  'review_comments',
  'human_approvals',
  'pr_state',
  'integration_events',
]

describe.skipIf(!HAS_DB)('@forge/state-store runMigrations', () => {
  let sql: ReturnType<typeof postgres>
  let schemaName: string
  let store: ForgeStateStore
  let stateDir: string

  beforeAll(async () => {
    if (!DATABASE_URL) return
    sql = postgres(DATABASE_URL, { max: 4 })
    schemaName = `forge_mig_${randomUUID().replace(/-/g, '').slice(0, 12)}`
    await sql.unsafe(`create schema "${schemaName}"`)
    // Point every subsequent search_path at our isolated schema.
    await sql.unsafe(`set search_path to "${schemaName}"`)

    stateDir = await tmpStateDir()
    store = new ForgeStateStore({
      config: defaultStateStoreConfig(stateDir, `${DATABASE_URL}?options=-c%20search_path%3D${schemaName}`),
    })
  })

  afterAll(async () => {
    if (!sql) return
    try {
      await sql.unsafe(`drop schema if exists "${schemaName}" cascade`)
    } finally {
      await sql.end({ timeout: 5 })
    }
    if (stateDir) await cleanup(stateDir)
  })

  it('applies every migration in MIGRATIONS on a fresh schema', async () => {
    const applied = await store.runMigrations(
      `${DATABASE_URL}?options=-c%20search_path%3D${schemaName}`,
    )
    expect(applied.length).toBe(MIGRATIONS.length)
    expect(applied).toEqual(MIGRATIONS.map((m) => m.version))
  })

  it('creates every documented baseline table in the target schema', async () => {
    const tables = await sql<{ table_name: string }[]>`
      select table_name
      from information_schema.tables
      where table_schema = ${schemaName}
        and table_type = 'BASE TABLE'
    `
    const present = new Set(tables.map((t) => t.table_name))
    const missing = EXPECTED_TABLES.filter((t) => !present.has(t))
    expect(missing).toEqual([])
  })

  it('records each applied migration in schema_migrations', async () => {
    const rows = await sql<{ version: number; name: string }[]>`
      select version, name from schema_migrations order by version asc
    `
    expect(rows.length).toBe(MIGRATIONS.length)
    for (const migration of MIGRATIONS) {
      const hit = rows.find((r) => r.version === migration.version)
      expect(hit?.name).toBe(migration.name)
    }
  })

  it('is idempotent — a second run applies no new versions', async () => {
    const applied = await store.runMigrations(
      `${DATABASE_URL}?options=-c%20search_path%3D${schemaName}`,
    )
    expect(applied).toEqual([])
  })

  it('refuses to run without a connection string', async () => {
    const localDir = await tmpStateDir()
    try {
      const offline = new ForgeStateStore({
        config: defaultStateStoreConfig(localDir, undefined),
      })
      await expect(offline.runMigrations()).rejects.toThrow(/connection string/)
    } finally {
      await cleanup(localDir)
    }
  })
})

describe('runMigrations surface (no DB)', () => {
  it('exposes runMigrations as a method on ForgeStateStore', async () => {
    const dir = await tmpStateDir()
    try {
      const offline = new ForgeStateStore({
        config: defaultStateStoreConfig(dir, undefined),
      })
      expect(typeof offline.runMigrations).toBe('function')
    } finally {
      await cleanup(dir)
    }
  })
})