/**
 * Adversarial verification driver for Track 10 state store.
 *
 * Re-derives the core claims independently of the producer's tests:
 *   1. tx<T>() uses a real Postgres transaction.
 *   2. Throwing in the callback rolls back BOTH writes AND trace events.
 *   3. Successful tx commits both writes AND trace events.
 *   4. trace_events row count matches exactly (no off-by-one).
 *   5. ArtifactStore writes bytes to disk AND metadata row to Postgres.
 *   6. ArtifactStore hash mismatch throws on read.
 *
 * Uses an isolated schema so the persistent "forge" DB stays clean.
 */
import postgres from 'postgres'
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import {
  ForgeStateStore,
  defaultStateStoreConfig,
} from '@forge/state-store'

const DATABASE_URL = process.env.FORGE_DATABASE_URL
if (!DATABASE_URL) {
  console.error('FORGE_DATABASE_URL not set — cannot verify')
  process.exit(1)
}

const RESULTS: { name: string; pass: boolean; detail: string }[] = []

function record(name: string, pass: boolean, detail: string) {
  RESULTS.push({ name, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}  —  ${detail}`)
}

async function main() {
  const sql = postgres(DATABASE_URL, { max: 4 })
  const schema = `forge_verify_${randomUUID().replace(/-/g, '').slice(0, 12)}`
  await sql.unsafe(`create schema "${schema}"`)
  await sql.unsafe(`set search_path to "${schema}"`)
  const stateDir = await mkdtemp(join(tmpdir(), 'forge-verify-'))
  const cs = `${DATABASE_URL}?options=-c%20search_path%3D${schema}`
  const store = new ForgeStateStore({
    config: defaultStateStoreConfig(stateDir, cs),
  })

  try {
    await store.init()

    // -----------------------------------------------------------
    // 1. tx() rollback: writes AND trace events must roll back
    // -----------------------------------------------------------
    {
      const repoId = randomUUID()
      const taskId = randomUUID()
      const traceCountBefore = await sql<{ c: number }[]>`select count(*)::int as c from trace_events`
      const reposCountBefore = await sql<{ c: number }[]>`select count(*)::int as c from repos`

      try {
        await store.tx(async (tx) => {
          await tx.repos.repos.insert({
            id: repoId,
            rootPath: '/tmp/should-rollback',
            name: 'should-rollback',
            currentBranch: 'main',
            payload: {},
          })
          await tx.repos.tasks.insert({
            id: taskId,
            repoId,
            title: 'will rollback',
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
          await tx.trace({
            type: 'task_created',
            taskId,
            repoId,
            actor: 'system',
            summary: 'will rollback',
            payload: {},
          })
          throw new Error('forced rollback')
        })
        record('tx-throws-rejects', false, 'expected throw did not occur')
      } catch (e) {
        const msg = (e as Error).message
        if (!msg.includes('forced rollback')) {
          record('tx-throws-rejects', false, `unexpected error: ${msg}`)
        } else {
          const repo = await store.repos.repos.get(repoId)
          const task = await store.repos.tasks.get(taskId)
          const traces = await store.repos.trace.listByTask(taskId)
          const traceCountAfter = await sql<{ c: number }[]>`select count(*)::int as c from trace_events`
          const reposCountAfter = await sql<{ c: number }[]>`select count(*)::int as c from repos`

          const ok =
            !repo &&
            !task &&
            traces.length === 0 &&
            traceCountAfter[0].c === traceCountBefore[0].c &&
            reposCountAfter[0].c === reposCountBefore[0].c
          record(
            'tx-rollback-fires-and-truncates-everything',
            ok,
            `repo=${repo ? 'PRESENT(leaked)' : 'absent'} task=${task ? 'PRESENT' : 'absent'} ` +
              `traces=${traces.length} trace_count=${traceCountBefore[0].c}→${traceCountAfter[0].c} ` +
              `repos_count=${reposCountBefore[0].c}→${reposCountAfter[0].c}`,
          )
        }
      }
    }

    // -----------------------------------------------------------
    // 2. tx() success: writes AND trace events commit together
    // -----------------------------------------------------------
    {
      const repoId = randomUUID()
      const taskId = randomUUID()
      const traceCountBefore = await sql<{ c: number }[]>`select count(*)::int as c from trace_events`

      await store.tx(async (tx) => {
        await tx.repos.repos.insert({
          id: repoId,
          rootPath: '/tmp/will-commit',
          name: 'will-commit',
          currentBranch: 'main',
          payload: {},
        })
        await tx.repos.tasks.insert({
          id: taskId,
          repoId,
          title: 'will commit',
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
        await tx.trace({
          type: 'task_created',
          taskId,
          repoId,
          actor: 'system',
          summary: 'committed',
          payload: {},
        })
      })

      const traceCountAfter = await sql<{ c: number }[]>`select count(*)::int as c from trace_events`
      const task = await store.repos.tasks.get(taskId)
      const traces = await store.repos.trace.listByTask(taskId)

      const ok =
        task?.title === 'will commit' &&
        traces.length === 1 &&
        traceCountAfter[0].c - traceCountBefore[0].c === 1
      record(
        'tx-success-commits-write-and-trace',
        ok,
        `task=${task ? 'present' : 'MISSING'} traces=${traces.length} ` +
          `delta=${traceCountAfter[0].c - traceCountBefore[0].c} (expected 1)`,
      )
    }

    // -----------------------------------------------------------
    // 3. ArtifactStore: bytes to disk + metadata to Postgres
    // -----------------------------------------------------------
    {
      const taskId = randomUUID()
      const data = Buffer.from('verification-driver-artifact-bytes')
      const expectedSha = createHash('sha256').update(data).digest('hex')

      const written = await store.writeArtifact(
        {
          taskId,
          artifactType: 'verification',
          relativePath: 'verify/driver.txt',
          summary: 'driver-written',
          payload: { source: 'verify-driver' },
        },
        data,
      )

      // Disk check
      let diskBytes: Buffer | null = null
      try {
        diskBytes = await readFile(written.path)
      } catch (e) {
        record('artifact-bytes-on-disk', false, `read failed: ${(e as Error).message}`)
      }
      const diskSha = diskBytes ? createHash('sha256').update(diskBytes).digest('hex') : ''
      record(
        'artifact-bytes-on-disk',
        !!diskBytes && diskSha === expectedSha,
        `path=${written.path} bytes=${diskBytes?.length ?? 'N/A'} sha_match=${diskSha === expectedSha}`,
      )

      // Postgres metadata check
      const meta = await sql<{ id: string; content_hash: string; size_bytes: number; mime: string | null }[]>`
        select id, content_hash, size_bytes, mime from artifacts where id = ${written.id}
      `
      const metaOk =
        meta.length === 1 &&
        meta[0].id === written.id &&
        meta[0].content_hash === `sha256:${expectedSha}` &&
        meta[0].size_bytes === data.length
      record(
        'artifact-metadata-in-postgres',
        metaOk,
        `rows=${meta.length} hash=${meta[0]?.content_hash ?? 'N/A'} size=${meta[0]?.size_bytes ?? 'N/A'}`,
      )

      // roundtrip via getArtifact
      const got = await store.getArtifact(written.id)
      const gotSha = got ? createHash('sha256').update(got.bytes).digest('hex') : ''
      record(
        'artifact-roundtrip',
        !!got && gotSha === expectedSha,
        `bytes_returned=${got?.bytes.length ?? 0} sha_match=${gotSha === expectedSha}`,
      )
    }

    // -----------------------------------------------------------
    // 4. Hash mismatch: tamper disk, expect throw on read
    // -----------------------------------------------------------
    {
      const taskId = randomUUID()
      const data = Buffer.from('original-bytes')
      const written = await store.writeArtifact(
        { taskId, artifactType: 'verification', relativePath: 'verify/tamper.txt' },
        data,
      )
      // Tamper
      await writeFile(written.path, Buffer.from('TAMPERED'))
      let threw = false
      let errMsg = ''
      try {
        await store.getArtifact(written.id)
      } catch (e) {
        threw = true
        errMsg = (e as Error).message
      }
      record(
        'artifact-tamper-detected',
        threw && errMsg.toLowerCase().includes('hash'),
        `threw=${threw} msg="${errMsg}"`,
      )
    }

    // -----------------------------------------------------------
    // 5. Orphan artifacts: pruneOrphans(dryRun) finds disk-only files
    // -----------------------------------------------------------
    {
      const orphanPath = join(stateDir, '.forge', 'artifacts', 'orphan-file.txt')
      await writeFile(orphanPath, Buffer.from('orphan'))
      const orphans = await store.orphanArtifacts()
      const found = orphans.find((o) => o.path === orphanPath)
      record(
        'orphan-list-finds-disk-only',
        !!found,
        `orphans=${orphans.length} hit=${!!found}`,
      )
    }

    // -----------------------------------------------------------
    // 6. Migration idempotency: re-run runMigrations and expect empty
    // -----------------------------------------------------------
    {
      const applied = await store.runMigrations(cs)
      record(
        'migration-idempotent',
        applied.length === 0,
        `applied=${JSON.stringify(applied)} (expected [])`,
      )
    }
  } finally {
    await sql.unsafe(`drop schema if exists "${schema}" cascade`)
    await sql.end({ timeout: 5 })
    await store.close()
    await rm(stateDir, { recursive: true, force: true })
  }

  const passed = RESULTS.filter((r) => r.pass).length
  const failed = RESULTS.filter((r) => !r.pass).length
  console.log(`\n=== Driver result: ${passed}/${RESULTS.length} passed ===`)
  if (failed > 0) process.exit(2)
}

main().catch((e) => {
  console.error('driver crashed:', e)
  process.exit(3)
})
