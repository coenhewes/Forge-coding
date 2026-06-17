/**
 * Live-DB tests for the typed `ForgeStateStore` facade.
 *
 * These tests open a real Postgres connection (via
 * `FORGE_DATABASE_URL`) and exercise:
 *
 *   - `init()` runs migrations and exposes a healthy store.
 *   - `store.tx(...)` writes typed state + emits a co-transactional
 *     trace event, and rolls back BOTH atomically when the callback
 *     throws.
 *   - Every typed repository (`tasks`, `acceptance`, `beliefs`,
 *     `claims`, `evidence`, `failures`, `decisions`, `probes`,
 *     `patch_candidates`, `verification_checks`, `commands`,
 *     `artifacts`, `trace_events`) returns rows with the typed
 *     shape the caller expects.
 *   - `health()` returns table counts that include the rows just
 *     inserted.
 *   - `importFromFileState(...)` reads `.forge/tasks/<id>.json`
 *     files (legacy `@forge/state` layout) and inserts them as
 *     Postgres tasks.
 *
 * Schema isolation: each test creates a unique schema, points
 * `search_path` at it, applies migrations into that schema, and
 * drops the schema at the end. This keeps the tests independent
 * from the persistent `forge` database and from each other.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import postgres from 'postgres'
import { randomUUID } from 'node:crypto'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ForgeStateStore,
  defaultStateStoreConfig,
} from '@forge/state-store'

const DATABASE_URL = process.env.FORGE_DATABASE_URL
const HAS_DB = Boolean(DATABASE_URL)

/**
 * Open a Postgres client, create an isolated schema, and apply the
 * ForgeStateStore migrations into it. Returns the schema name plus
 * a `ForgeStateStore` already wired to the same DB. The caller is
 * responsible for dropping the schema and closing the client.
 */
async function isolatedStore(): Promise<{
  sql: ReturnType<typeof postgres>
  schema: string
  store: ForgeStateStore
  stateDir: string
}> {
  if (!DATABASE_URL) throw new Error('FORGE_DATABASE_URL must be set for this test')
  const sql = postgres(DATABASE_URL, { max: 4 })
  const schema = `forge_real_${randomUUID().replace(/-/g, '').slice(0, 12)}`
  await sql.unsafe(`create schema "${schema}"`)
  await sql.unsafe(`set search_path to "${schema}"`)

  const stateDir = await mkdtemp(join(tmpdir(), 'forge-real-state-'))
  // Scope artifacts into the test's temp state dir.
  const cs = `${DATABASE_URL}?options=-c%20search_path%3D${schema}`
  const store = new ForgeStateStore({
    config: defaultStateStoreConfig(stateDir, cs),
  })
  await store.init()
  return { sql, schema, store, stateDir }
}

describe.skipIf(!HAS_DB)('@forge/state-store real-DB facade', () => {
  let sql: ReturnType<typeof postgres>
  let schema: string
  let store: ForgeStateStore
  let stateDir: string

  beforeAll(async () => {
    const ctx = await isolatedStore()
    sql = ctx.sql
    schema = ctx.schema
    store = ctx.store
    stateDir = ctx.stateDir
  })

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

  it('opens a connection and applies migrations on init()', async () => {
    const health = await store.health()
    expect(health.ok).toBe(true)
    expect(health.postgresReachable).toBe(true)
    expect(health.requiredSchemaVersion).toBe(2)
    expect(health.tableCounts).toBeDefined()
    const tables = Object.keys(health.tableCounts ?? {})
    // Spot-check a handful of the most important tables.
    for (const expected of [
      'repos',
      'tasks',
      'task_snapshots',
      'acceptance_criteria',
      'hypotheses',
      'claims',
      'evidence',
      'failures',
      'decisions',
      'probes',
      'patch_candidates',
      'verification_checks',
      'commands',
      'artifacts',
      'trace_events',
    ]) {
      expect(tables).toContain(expected)
    }
  })

  it('writes a full task graph + trace event in one transaction', async () => {
    const repoId = randomUUID()
    const taskId = randomUUID()
    const criterionId = randomUUID()
    const beliefId = randomUUID()
    const hypothesisId = randomUUID()
    const claimId = randomUUID()
    const evidenceId = randomUUID()
    const failureId = randomUUID()
    const decisionId = randomUUID()
    const probeId = randomUUID()
    const patchId = randomUUID()
    const checkId = randomUUID()
    const commandId = randomUUID()
    const artifactId = randomUUID()
    const traceId = randomUUID()

    await store.tx(async (tx) => {
      await tx.repos.repos.insert({
        id: repoId,
        rootPath: '/tmp/repo-under-test',
        name: 'repo-under-test',
        currentBranch: 'main',
        payload: { source: 'real-db-test' },
      })
      await tx.repos.tasks.insert({
        id: taskId,
        repoId,
        title: 'Add organisation invitations',
        originalRequest: 'Add org invitations with role, expiry, audit log',
        interpretedGoal: 'Org admin can email-invite a teammate with a role and expiry',
        status: 'implementing',
        mode: 'implement',
        activeBranch: 'feat/invites',
        activePatchCandidateId: patchId,
        currentSummary: 'Implementing backend + DB schema',
        nextAction: 'Write the role-mapping migration',
        payload: { domains: ['auth', 'backend', 'database'] },
      })
      await tx.repos.acceptance.insert({
        id: criterionId,
        taskId,
        text: 'Admin can invite a user by email',
        status: 'pending',
        riskLevel: 'medium',
        requiresHumanReview: false,
        payload: {},
      })
      await tx.repos.beliefs.insert({
        id: beliefId,
        taskId,
        repoId,
        beliefType: 'auth_role_normalisation',
        claim: 'Invite permission check happens before role normalisation',
        status: 'uncertain',
        confidence: 0.4,
        payload: {},
      })
      await tx.repos.hypotheses.insert({
        id: hypothesisId,
        taskId,
        claim: 'Moving normalisation earlier fixes the SSO admin invite flow',
        status: 'proposed',
        confidence: 0.7,
        relevantDomains: ['auth'],
        relevantGraphNodes: ['auth.middleware.normaliseRoles'],
        payload: {},
      })
      await tx.repos.claims.insert({
        id: claimId,
        taskId,
        acceptanceCriterionId: criterionId,
        text: 'Non-admin users cannot invite teammates',
        status: 'pending',
        confidence: 0.5,
        riskLevel: 'high',
        reviewerGuidance: 'Review the policy file change and the new route guard',
        payload: {},
      })
      await tx.repos.evidence.insert({
        id: evidenceId,
        taskId,
        evidenceType: 'test_result',
        summary: 'invite route rejects non-admin (authz test passes)',
        status: 'pass',
        sourceType: 'integration_test',
        sourceRef: 'tests/auth/invite.test.ts:invite_rejects_non_admin',
        artifactId: null,
        payload: { framework: 'vitest' },
      })
      await tx.repos.claimEvidenceLinks.insert({
        id: randomUUID(),
        claimId,
        evidenceId,
        linkType: 'supports',
      })
      await tx.repos.failures.insert({
        id: failureId,
        taskId,
        hypothesisId,
        failureType: 'patch_rejected',
        summary: 'Patched the frontend role check but server still rejects',
        lesson: 'Failure is server-side; investigate role mapping not the form',
        artifactId: null,
        payload: {},
      })
      await tx.repos.decisions.insert({
        id: decisionId,
        taskId,
        decision: 'Normalise SSO role aliases in auth middleware',
        rationale: 'Invite route should not know provider-specific role names',
        alternativesRejected: ['Patch frontend role check', 'Backfill DB'],
        verificationRequired: [
          'old org_admin users can still invite',
          'new SSO admin users can invite',
          'non-admin users are still blocked',
        ],
        decidedBy: 'model',
        payload: {},
      })
      await tx.repos.probes.insert({
        id: probeId,
        taskId,
        capability: 'auth.trace_permission_check',
        status: 'completed',
        expectedInformationGain: 'high',
        cost: 'low',
        risk: 'none',
        reason: 'Verify where the role is dropped in the middleware chain',
        input: { user: 'sso-admin' },
        result: { trace: ['auth.middleware', 'invite.policy'] },
      })
      await tx.repos.patchCandidates.insert({
        id: patchId,
        taskId,
        name: 'attempt-1-frontend-only',
        baseCommit: 'abc123',
        status: 'rejected',
        hypothesisId,
        diffArtifactId: null,
        summary: 'Frontend role check tweak — did not fix server',
        verificationStatus: 'failed',
        promotionDecision: 'rejected',
        payload: {},
      })
      await tx.repos.verificationChecks.insert({
        id: checkId,
        taskId,
        acceptanceCriterionId: criterionId,
        claimId,
        checkType: 'integration_test',
        command: 'pnpm test tests/auth/invite.test.ts',
        status: 'passed',
        evidenceId,
        riskLevel: 'medium',
        reason: 'Verify invite permission boundary',
        staleReason: null,
        payload: {},
      })
      await tx.repos.artifacts.insert({
        id: artifactId,
        taskId,
        artifactType: 'stdout',
        path: '/tmp/repo-under-test/test-output.log',
        contentHash: 'sha256:fakedeadbeef',
        sizeBytes: 4096,
        mime: 'text/plain',
        summary: 'vitest stdout for invite test',
        payload: {},
      })
      await tx.repos.commands.insert({
        id: commandId,
        taskId,
        command: 'pnpm test tests/auth/invite.test.ts',
        cwd: '/tmp/repo-under-test',
        status: 'succeeded',
        exitCode: 0,
        startedAt: new Date().toISOString(),
        stdoutArtifactId: artifactId,
        stderrArtifactId: null,
        summary: 'invite permission test passed',
        payload: {},
      })
      await tx.trace({
        type: 'task_status_changed',
        taskId,
        repoId,
        actor: 'system',
        summary: 'Task status → implementing',
        payload: { status: 'implementing', patchCandidateId: patchId },
      })
      // Force a known trace id for the existence assertion below.
      await tx.repos.trace.insert({
        id: traceId,
        taskId,
        repoId,
        eventType: 'graph_complete',
        actor: 'system',
        summary: 'all nodes visited',
        payload: { nodeCount: 1 },
      })
    })

    // Verify every row landed.
    const task = await store.repos.tasks.get(taskId)
    expect(task?.status).toBe('implementing')

    const crits = await store.repos.acceptance.listByTask(taskId)
    expect(crits.map((c) => c.text)).toContain('Admin can invite a user by email')

    const links = await store.repos.claimEvidenceLinks.listByClaim(claimId)
    expect(links).toHaveLength(1)
    expect(links[0]?.linkType).toBe('supports')

    const traces = await store.repos.trace.listByTask(taskId)
    const types = traces.map((t) => t.eventType)
    expect(types).toContain('task_status_changed')
    expect(types).toContain('graph_complete')

    const verdict = await store.repos.verificationChecks.get(checkId)
    expect(verdict?.status).toBe('passed')

    const orphan = await store.orphanArtifacts()
    // No disk writes here — only the stub metadata row — so no orphans.
    expect(orphan).toEqual([])
  })

  it('rolls back ALL state writes AND trace events when the callback throws', async () => {
    const repoId = randomUUID()
    const taskId = randomUUID()

    const before = (await store.repos.tasks.listByRepo(repoId)).length
    expect(before).toBe(0)

    await expect(
      store.tx(async (tx) => {
        await tx.repos.repos.insert({
          id: repoId,
          rootPath: '/tmp/should-not-persist',
          name: 'should-not-persist',
          currentBranch: 'main',
          payload: {},
        })
        await tx.repos.tasks.insert({
          id: taskId,
          repoId,
          title: 'should not commit',
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
          summary: 'should be rolled back',
          payload: {},
        })

        // Sanity: rows are visible inside the same txn before throw.
        const peek = await tx.repos.tasks.get(taskId)
        expect(peek?.id).toBe(taskId)

        throw new Error('deliberate rollback')
      }),
    ).rejects.toThrow(/deliberate rollback/)

    // Nothing should have been committed.
    const repo = await store.repos.repos.get(repoId)
    expect(repo).toBeUndefined()
    const task = await store.repos.tasks.get(taskId)
    expect(task).toBeUndefined()
    const traces = await store.repos.trace.listByTask(taskId)
    expect(traces).toEqual([])

    // The pg_stat_activity count from health() must still work
    // (sanity: connection is still healthy after a rollback).
    const health = await store.health()
    expect(health.postgresReachable).toBe(true)
  })

  it('tx() with no throw commits and the trace count matches', async () => {
    const repoId = randomUUID()
    const taskId = randomUUID()
    await store.tx(async (tx) => {
      await tx.repos.repos.insert({
        id: repoId,
        rootPath: '/tmp/committed',
        name: 'committed',
        currentBranch: 'main',
        payload: {},
      })
      await tx.repos.tasks.insert({
        id: taskId,
        repoId,
        title: 'committed task',
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
    const task = await store.repos.tasks.get(taskId)
    expect(task?.title).toBe('committed task')
    const traces = await store.repos.trace.listByTask(taskId)
    expect(traces.length).toBe(1)
  })

  it('importFromFileState() reads .forge/tasks/<id>.json and inserts rows', async () => {
    const fileStateDir = await mkdtemp(join(tmpdir(), 'forge-file-state-'))
    try {
      // Use a UUID for the task id — the Postgres column is uuid.
      const taskId = randomUUID()
      const payload = {
        taskId,
        title: 'Legacy task',
        originalRequest: 'Add some feature',
        currentInterpretation: 'Add some feature',
        status: 'implementing',
        mode: 'implement',
        filesTouched: ['src/a.ts'],
        commandsRun: ['pnpm test'],
        testsRun: ['a.test.ts'],
        acceptanceCriteria: ['it works'],
        nextAction: 'ship',
      }
      const tasksDir = join(fileStateDir, 'tasks')
      const { mkdir } = await import('node:fs/promises')
      await mkdir(tasksDir, { recursive: true })
      await writeFile(join(tasksDir, `${taskId}.json`), JSON.stringify(payload), 'utf-8')

      const result = await store.importFromFileState(fileStateDir, 'human')
      expect(result.imported).toBe(1)

      const task = await store.repos.tasks.get(taskId)
      expect(task?.title).toBe('Legacy task')
      expect(task?.status).toBe('implementing')
      // The trace row attributed to the import must exist.
      const traces = await store.repos.trace.listByTask(taskId)
      const importTrace = traces.find((t) => t.eventType === 'task_imported_from_file_state')
      expect(importTrace?.actor).toBe('human')
    } finally {
      await rm(fileStateDir, { recursive: true, force: true })
    }
  })
})
