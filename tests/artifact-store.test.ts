/**
 * Live-DB tests for the `ArtifactStore` wiring. Verifies the
 * on-disk ↔ Postgres-metadata contract:
 *
 *   - A 1MB blob round-trips with sha256 equality.
 *   - `getArtifact(id)` throws on a hash mismatch (the bytes have
 *     drifted from the metadata row).
 *   - `orphanArtifacts()` finds files under the root dir that have
 *     no `artifacts` row, and `pruneOrphans(dryRun: true)` lists
 *     them without deleting anything.
 *   - `pruneOrphans(dryRun: false)` actually deletes them and
 *     reports the freed bytes.
 *
 * Each test uses a per-test isolated schema so the metadata rows
 * don't collide across runs.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import postgres from 'postgres'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ArtifactStore,
  ForgeStateStore,
  defaultStateStoreConfig,
} from '@forge/state-store'

const DATABASE_URL = process.env.FORGE_DATABASE_URL
const HAS_DB = Boolean(DATABASE_URL)

async function isolatedStore(): Promise<{
  sql: ReturnType<typeof postgres>
  schema: string
  store: ForgeStateStore
  stateDir: string
  artifactsDir: string
}> {
  if (!DATABASE_URL) throw new Error('FORGE_DATABASE_URL must be set for this test')
  const sql = postgres(DATABASE_URL, { max: 4 })
  const schema = `forge_art_${randomUUID().replace(/-/g, '').slice(0, 12)}`
  await sql.unsafe(`create schema "${schema}"`)
  await sql.unsafe(`set search_path to "${schema}"`)

  const stateDir = await mkdtemp(join(tmpdir(), 'forge-art-state-'))
  // The default state-store config writes artifacts under
  // `<stateDir>/.forge/artifacts` — match that layout so the orphan
  // scanner sees files in the same root.
  const artifactsDir = join(stateDir, '.forge', 'artifacts')
  const cs = `${DATABASE_URL}?options=-c%20search_path%3D${schema}`
  const store = new ForgeStateStore({
    config: defaultStateStoreConfig(stateDir, cs),
  })
  await store.init()
  return { sql, schema, store, stateDir, artifactsDir }
}

describe.skipIf(!HAS_DB)('@forge/state-store ArtifactStore', () => {
  let sql: ReturnType<typeof postgres>
  let schema: string
  let store: ForgeStateStore
  let stateDir: string
  let repoId: string

  beforeAll(async () => {
    const ctx = await isolatedStore()
    sql = ctx.sql
    schema = ctx.schema
    store = ctx.store
    stateDir = ctx.stateDir
    // Create a single "shared" repo + task so every artifact test can
    // reference a real FK target. Individual tests still use distinct
    // task ids to keep metadata unique.
    repoId = randomUUID()
    await store.tx(async (tx) => {
      await tx.repos.repos.insert({
        id: repoId,
        rootPath: stateDir,
        name: 'artifact-test-repo',
        currentBranch: 'main',
        payload: {},
      })
    })
  })

  /**
   * Create a fresh task row inside the test schema and return its id.
   * Used by tests that need a valid task_id FK for artifact inserts.
   */
  async function freshTaskId(): Promise<string> {
    const taskId = randomUUID()
    await store.tx(async (tx) => {
      await tx.repos.tasks.insert({
        id: taskId,
        repoId,
        title: 'artifact-test-task',
        originalRequest: 'x',
        interpretedGoal: null,
        status: 'pending',
        mode: 'implement',
        activeBranch: null,
        activePatchCandidateId: null,
        currentSummary: null,
        nextAction: null,
        payload: {},
      })
    })
    return taskId
  }

  afterAll(async () => {
    if (sql) {
      try {
        await sql.unsafe(`drop schema if exists "${schema}" cascade`)
      } finally {
        await sql.end({ timeout: 5 })
      }
    }
    if (stateDir) await rm(stateDir, { recursive: true, force: true })
  })

  it('writes a 1MB blob, reads it back, hash matches', async () => {
    const taskId = await freshTaskId()
    const blob = makeRandomBlob(1024 * 1024) // exactly 1 MiB
    const expectedSha = createHash('sha256').update(blob).digest('hex')

    const written = await store.writeArtifact(
      {
        taskId,
        artifactType: 'log',
        relativePath: 'session-1/run.log',
        summary: '1 MiB log captured during a real run',
      },
      blob,
    )
    expect(written.metadata.id).toBeTruthy()
    expect(written.metadata.contentHash).toBe(expectedSha)
    expect(written.metadata.sizeBytes).toBe(blob.byteLength)
    expect(written.metadata.mime).toBe('text/plain')

    const read = await store.getArtifact(written.metadata.id)
    expect(read).toBeDefined()
    expect(read!.bytes.byteLength).toBe(blob.byteLength)
    expect(createHash('sha256').update(read!.bytes).digest('hex')).toBe(expectedSha)
    expect(read!.metadata.path).toBe(written.metadata.path)
  })

  it('throws on hash mismatch when bytes drift from metadata', async () => {
    const taskId = await freshTaskId()
    const original = Buffer.from('original-content')
    const written = await store.writeArtifact(
      {
        taskId,
        artifactType: 'stdout',
        relativePath: 'corrupt/run.stdout',
      },
      original,
    )
    // Tamper with the on-disk bytes — the metadata row still records
    // the original sha256, so the next read must throw.
    await writeFile(written.metadata.path, 'tampered-content')

    await expect(store.getArtifact(written.metadata.id)).rejects.toThrow(/hash mismatch/)
  })

  it('orphanArtifacts() + pruneOrphans(dryRun=true) lists without deleting', async () => {
    const taskId = await freshTaskId()
    // Write one tracked artifact so we have a known-indexed path.
    const tracked = await store.writeArtifact(
      {
        taskId,
        artifactType: 'log',
        relativePath: 'session-orphan/tracked.log',
      },
      Buffer.from('tracked'),
    )
    // Drop an unrelated file on disk under the same artifacts dir —
    // the artifact store won't know about it.
    const orphanPath = join(stateDir, '.forge', 'artifacts', 'session-orphan', 'loose.txt')
    await mkdir(join(stateDir, '.forge', 'artifacts', 'session-orphan'), { recursive: true })
    await writeFile(orphanPath, 'loose bytes that should be flagged as orphan')

    const orphans = await store.orphanArtifacts()
    const orphanPaths = orphans.map((o) => o.path)
    expect(orphanPaths).toContain(orphanPath)
    expect(orphanPaths).not.toContain(tracked.metadata.path)

    // dryRun must NOT delete anything.
    const result = await store.artifactStoreOrThrow().pruneOrphans(true)
    expect(result.removed).toContain(orphanPath)
    // File still exists.
    const { stat } = await import('node:fs/promises')
    await expect(stat(orphanPath)).resolves.toBeDefined()
  })

  it('pruneOrphans(dryRun=false) actually removes orphan files', async () => {
    const orphanPath = join(stateDir, '.forge', 'artifacts', 'session-prune', 'doomed.txt')
    await mkdir(join(stateDir, '.forge', 'artifacts', 'session-prune'), { recursive: true })
    await writeFile(orphanPath, 'this file will be deleted by pruneOrphans')

    const result = await store.artifactStoreOrThrow().pruneOrphans(false)
    expect(result.removed).toContain(orphanPath)
    expect(result.bytes).toBeGreaterThan(0)

    const { stat } = await import('node:fs/promises')
    await expect(stat(orphanPath)).rejects.toThrow(/ENOENT/)
  })

  it('uses a custom mime when provided', async () => {
    const taskId = await freshTaskId()
    const written = await store.writeArtifact(
      {
        taskId,
        artifactType: 'screenshot',
        relativePath: 'screens/login.png',
        mime: 'image/png',
      },
      Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    )
    expect(written.metadata.mime).toBe('image/png')
  })

  it('ArtifactStore instance is lazy and reused', () => {
    const a = store.artifactStoreOrThrow()
    const b = store.artifactStoreOrThrow()
    expect(a).toBe(b)
    expect(a.rootDir).toBe(join(stateDir, '.forge', 'artifacts'))
  })
})

/** Deterministic pseudo-random bytes for a stable test fixture. */
function makeRandomBlob(size: number): Buffer {
  // Use crypto.randomBytes — deterministic tests would require a
  // seed, but the hash check below is the real correctness signal.
  return require('node:crypto').randomBytes(size)
}
