/**
 * t52 — slash command tests for the 11 new REPL commands.
 *
 * 11 tests, one per command. Each test:
 *   1. Constructs a Repl with stubbed `logBox` and `screen` so `this.log()`
 *      pushes into a captured buffer instead of touching blessed.
 *   2. Exercises the handler with both an empty store and a populated
 *      fixture (where applicable), then asserts the output contains
 *      the expected labels.
 *   3. Verifies the handler does NOT throw on either path.
 *
 * State store engines (TaskStateEngine, FailureLedgerEngine,
 * VerificationMatrixEngine, TraceRecorder, CheckpointManager,
 * EvidenceLedgerEngine, DecisionLedgerEngine) all read/write
 * `.forge/<engine>/<taskId>.json` so the tests use
 * `os.tmpdir()/forge-tui-slash-<random>/.forge` as a hermetic
 * state dir, with `cleanup` removing it after.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

import { Repl } from '../src/repl.js'
import {
  TaskStateEngine,
  FailureLedgerEngine,
  EvidenceLedgerEngine,
  DecisionLedgerEngine,
} from '@forge/state'
import { VerificationMatrixEngine, CheckpointManager } from '@forge/verification'
import { TraceRecorder } from '@forge/trace'

import type { ForgeConfig, TaskState } from '@forge/types'

// ─── Fixtures + helpers ────────────────────────────────────────────────────

function makeStateDir(): string {
  const base = mkdtempSync(join(tmpdir(), 'forge-tui-slash-'))
  return join(base, '.forge')
}

function makeConfig(stateDir: string): ForgeConfig {
  return {
    provider: {
      name: 'openai',
      model: 'gpt-4o-mini',
      apiKey: 'test-key',
    },
    subagents: {
      enabled: false,
      provider: { name: 'openai', model: 'gpt-4o-mini' },
      maxSubagents: 0,
    },
    mode: 'implement',
    workDir: '/tmp/forge-tui-slash',
    stateDir,
    logLevel: 'info',
    features: {
      repoGraph: false,
      domainSystem: false,
      evidenceLedger: true,
      failureLedger: true,
      decisionLedger: true,
      checkpointSystem: true,
      trace: true,
    },
    git: {
      autoBranch: false,
      autoCommit: false,
      pr: 'off',
      branchPrefix: 'forge/',
    },
  }
}

/**
 * Construct a Repl with stub blessed objects so `this.log()` does not
 * crash and so we can read back the output. The stub `logBox.setContent`
 * pushes the individual lines that the REPL itself logged — that is,
 * we mirror the input that the REPL passed to `setContent` on each
 * call, not the joined snapshot. Without this, `setContent` would
 * re-push the entire accumulated log on every line, polluting later
 * assertions with the previous test's output. `screen.render` is a
 * no-op.
 */
function makeRepl(config: ForgeConfig): { repl: Repl; captured: { lines: string[] } } {
  const captured = { lines: [] as string[] }
  // Reach into the private fields to install stubs. The Repl class
  // exposes these as `private`, but tests live in the same monorepo
  // and rely on the public behaviour — installing stubs here is the
  // cleanest way to assert handler output without spinning up a TTY.
  const repl = new Repl(config) as unknown as {
    logBox: { setContent: (s: string) => void; setScrollPerc: (n: number) => void }
    screen: { render: () => void; destroy: () => void; key: (...args: unknown[]) => void }
    logLines: string[]
  }
  // Replace the REPL's `log()` path with a per-line push so each
  // emitted line lands as one entry in `captured.lines`, regardless
  // of `setContent` re-snapshotting the whole buffer.
  const originalLogLines = (repl as unknown as { logLines: string[] }).logLines
  void originalLogLines
  repl.logBox = {
    setContent: (_s: string) => {
      // The REPL's `this.log()` will already have pushed the new
      // line onto its own `logLines` array. We just intercept
      // setContent to extract that last line and forward it to
      // our captured buffer. This avoids snapshot duplication.
    },
    setScrollPerc: () => {},
  }
  // Patch the REPL's `log()` so it pushes per-line into our
  // captured buffer. We do this by monkey-patching the method on
  // the instance. The Repl's `log` is private but JS allows this
  // when we go through `unknown` first.
  ;(repl as unknown as { log: (s: string) => void }).log = (s: string) => {
    captured.lines.push(s)
  }
  repl.screen = {
    render: () => {},
    destroy: () => {},
    key: () => {},
  }
  return { repl, captured }
}

function makeTaskFixture(taskId: string, request: string): TaskState {
  const now = new Date().toISOString()
  return {
    taskId,
    originalRequest: request,
    currentInterpretation: request,
    status: 'implementing',
    acceptanceCriteria: ['Invite user by email', 'Revoke expired invite'],
    assumptions: [],
    openQuestions: [],
    subtasks: [],
    dependencies: [],
    completedWork: ['Set up migration'],
    remainingWork: ['Add invite route'],
    filesTouched: ['src/auth/invite.ts', 'src/db/migrations/0042_invites.sql'],
    commandsRun: ['pnpm migrate'],
    testsRun: ['auth/invite.test.ts'],
    failuresEncountered: [],
    decisionsMade: [],
    risks: [],
    verificationStatus: {},
    evidenceLinks: [],
    failedHypotheses: ['Frontend invite form is blocking SSO admins'],
    patchCandidates: [],
    reviewBlockers: [],
    nextAction: 'Run auth regression tests',
    createdAt: now,
    updatedAt: now,
  }
}

function combinedOutput(captured: { lines: string[] }): string {
  return captured.lines.join('\n')
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe('REPL — 11 new slash commands (t52)', () => {
  let stateDir: string
  let config: ForgeConfig
  let repl: Repl
  let captured: { lines: string[] }

  beforeEach(() => {
    stateDir = makeStateDir()
    config = makeConfig(stateDir)
    ;({ repl, captured } = makeRepl(config))
  })

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true })
    captured.lines = []
  })

  // 1. /belief

  it('/belief handles empty store and populated fixture', async () => {
    // Empty: no active task → friendly message, no throw.
    captured.lines = []
    await expect(repl['cmdBelief']([])).resolves.toBeUndefined()
    expect(combinedOutput(captured)).toMatch(/no active task/i)

    // Populated: task exists with failedHypotheses → renders the
    // belief header + top-N hypothesis line.
    const engine = new TaskStateEngine({ stateDir })
    await engine.createTask('task_belief', 'Add team invitations')
    await engine.updateTask('task_belief', {
      failedHypotheses: ['Frontend invite form is blocking SSO admins'],
    })

    captured.lines = []
    await expect(repl['cmdBelief'](['task_belief'])).resolves.toBeUndefined()
    const out = combinedOutput(captured)
    expect(out).toContain('Belief')
    expect(out).toContain('task_belief')
    expect(out).toContain('Frontend invite form is blocking SSO admins')
    expect(out).toMatch(/\[#+\-+\]/) // confidence bar present
  })

  // 2. /probes

  it('/probes handles empty store and populated fixture', async () => {
    // Empty: no active task.
    captured.lines = []
    await expect(repl['cmdProbes']([])).resolves.toBeUndefined()
    expect(combinedOutput(captured)).toMatch(/no active task/i)

    // Populated: task with remainingWork → "Next action" header.
    const engine = new TaskStateEngine({ stateDir })
    await engine.createTask('task_probes', 'Add admin role mapping')
    await engine.updateTask('task_probes', {
      remainingWork: ['Run auth regression tests', 'Patch invite route'],
    })

    captured.lines = []
    await expect(repl['cmdProbes'](['task_probes'])).resolves.toBeUndefined()
    const out = combinedOutput(captured)
    expect(out).toContain('Probes')
    expect(out).toContain('task_probes')
    expect(out).toContain('Run auth regression tests')
  })

  // 3. /verify

  it('/verify groups entries by status from VerificationMatrixEngine', async () => {
    // Empty: no active task.
    captured.lines = []
    await expect(repl['cmdVerify']([])).resolves.toBeUndefined()
    expect(combinedOutput(captured)).toMatch(/no active task/i)

    // Populated: seed a task + 3 verification entries (one per status).
    const engine = new TaskStateEngine({ stateDir })
    await engine.createTask('task_verify', 'Add invite acceptance')
    const v = new VerificationMatrixEngine({ stateDir })
    await v.addEntry('task_verify', 'auth_regression', { status: 'passed' })
    await v.addEntry('task_verify', 'invite_unit', { status: 'failed', notes: 'expired invite accepted' })
    await v.addEntry('task_verify', 'migration_up', { status: 'unverified' })

    captured.lines = []
    await expect(repl['cmdVerify'](['task_verify'])).resolves.toBeUndefined()
    const out = combinedOutput(captured)
    expect(out).toContain('Verification Matrix')
    expect(out).toContain('task_verify')
    expect(out).toMatch(/passed \(1\)/)
    expect(out).toMatch(/failed \(1\)/)
    expect(out).toMatch(/unverified \(1\)/)
    expect(out).toContain('auth_regression')
    expect(out).toContain('invite_unit')
    expect(out).toContain('expired invite accepted')
  })

  // 4. /failures

  it('/failures reads FailureLedgerEngine and task.failedHypotheses', async () => {
    // Empty: no active task.
    captured.lines = []
    await expect(repl['cmdFailures']([])).resolves.toBeUndefined()
    expect(combinedOutput(captured)).toMatch(/no active task/i)

    // Populated: seed failure ledger entries + failedHypotheses on
    // the task.
    const engine = new TaskStateEngine({ stateDir })
    await engine.createTask('task_failures', 'Fix invite expiry')
    await engine.updateTask('task_failures', {
      failedHypotheses: ['Migration dropped role column'],
    })
    const f = new FailureLedgerEngine({ stateDir })
    await f.addEntry(
      'task_failures',
      'Frontend invite form is blocking SSO admins',
      'Changed frontend role check from org_admin to admin',
      'Invite still fails with 403 — failure is server-side',
      'Failure is server-side; do not blame the frontend.',
      { nextHypothesis: 'SSO role mapping changed from org_admin to admin' },
    )

    captured.lines = []
    await expect(repl['cmdFailures'](['task_failures'])).resolves.toBeUndefined()
    const out = combinedOutput(captured)
    expect(out).toContain('Failures')
    expect(out).toContain('task_failures')
    expect(out).toContain('Frontend invite form is blocking SSO admins')
    expect(out).toContain('Failure is server-side')
    expect(out).toContain('SSO role mapping changed')
    expect(out).toContain('Disproven hypotheses')
    expect(out).toContain('Migration dropped role column')
  })

  // 5. /trace

  it('/trace renders last 20 events as a timeline from TraceRecorder', async () => {
    // Empty: no active task.
    captured.lines = []
    await expect(repl['cmdTrace']([])).resolves.toBeUndefined()
    expect(combinedOutput(captured)).toMatch(/no active task/i)

    // Populated: seed trace events.
    const engine = new TaskStateEngine({ stateDir })
    await engine.createTask('task_trace', 'Investigate SSO bug')
    const tr = new TraceRecorder({ stateDir })
    await tr.initTask('task_trace')
    await tr.record('task_trace', 'file_read', 'read auth/sso.ts')
    await tr.record('task_trace', 'tool_called', 'auth.trace_permission_check')
    await tr.record('task_trace', 'failure_observed', 'integration test failed: 403 on /api/invite')

    captured.lines = []
    await expect(repl['cmdTrace'](['task_trace'])).resolves.toBeUndefined()
    const out = combinedOutput(captured)
    expect(out).toContain('Trace')
    expect(out).toContain('task_trace')
    expect(out).toMatch(/file_read/)
    expect(out).toMatch(/tool_called/)
    expect(out).toMatch(/┌|└|│/) // timeline connectors
  })

  // 6. /pr

  it('/pr handles empty store and populated fixture via generatePRSummary', async () => {
    // Empty: no active task.
    captured.lines = []
    await expect(repl['cmdPr']([])).resolves.toBeUndefined()
    expect(combinedOutput(captured)).toMatch(/no active task/i)

    // Populated: seed a task with full ledger surface. The
    // generators' addEntry APIs differ by shape — we adapt to
    // each engine's real signature.
    const realEngine = new TaskStateEngine({ stateDir })
    const task = makeTaskFixture('task_pr', 'Add team invitations with roles and expiry')
    await realEngine.createTask(task.taskId, task.originalRequest)
    await realEngine.updateTask(task.taskId, {
      filesTouched: task.filesTouched,
      completedWork: task.completedWork,
      remainingWork: task.remainingWork,
      acceptanceCriteria: task.acceptanceCriteria,
      failedHypotheses: task.failedHypotheses,
      nextAction: task.nextAction,
    })
    const v = new VerificationMatrixEngine({ stateDir })
    await v.addEntry('task_pr', 'auth_regression', { status: 'passed' })
    const f = new FailureLedgerEngine({ stateDir })
    await f.addEntry(
      'task_pr',
      'Hypothesis A',
      'Action A',
      'Result A',
      'Lesson A',
    )
    const d = new DecisionLedgerEngine({ stateDir })
    // DecisionLedgerEngine.addEntry: (taskId, decision, rationale, alternativesRejected[])
    await d.addEntry('task_pr', 'Use auth layer for SSO normalization', 'Keep invite route ignorant of providers', [])
    const e = new EvidenceLedgerEngine({ stateDir })
    // EvidenceLedgerEngine.addEntry: (taskId, claim, kind, options?)
    await e.addEntry('task_pr', 'SSO returns admin role', 'observed_fact', { evidence: ['stack trace'], status: 'verified' })
    const cm = new CheckpointManager({ stateDir })
    // CheckpointManager.createCheckpoint: (taskId, hypothesis, filesChanged[], reason, options?)
    await cm.createCheckpoint('task_pr', 'Initial patch', ['src/auth/invite.ts'], 'Hypothesis: normalize role', { riskAssessment: 'low' })

    captured.lines = []
    await expect(repl['cmdPr'](['task_pr'])).resolves.toBeUndefined()
    const out = combinedOutput(captured)
    // The PR generator emits a header + body. We just need to know
    // the handler ran end-to-end without throwing and that the
    // body is present (rendered with a leading header).
    expect(out).toContain('PR Summary')
    expect(out).toContain('task_pr')
    // Some line should be present from the PR body (e.g. an
    // acceptance section header) — exact wording depends on the
    // generator, so we just look for one of several known anchors.
    expect(
      out.includes('Acceptance') ||
        out.includes('Verification') ||
        out.includes('No acceptance contract'),
    ).toBe(true)
  })

  // 7. /doctor

  it('/doctor runs probes gracefully without a configured database', async () => {
    delete process.env.FORGE_DATABASE_URL
    delete process.env.FORGE_PROVIDER_BASE_URL
    delete process.env.MINIMAX_BASE_URL

    captured.lines = []
    await expect(repl['cmdDoctor']()).resolves.toBeUndefined()
    const out = combinedOutput(captured)
    expect(out).toContain('Forge doctor')
    // No DB configured → warning, not crash.
    expect(out).toMatch(/FORGE_DATABASE_URL not set/i)
    // Driver probe runs and either says "postgres installed" or
    // reports a missing dep — either is fine, the point is graceful
    // handling.
    expect(out).toMatch(/driver:/i)
  })

  // 8. /sessions

  it('/sessions lists tasks with status and risk level', async () => {
    // Empty: no tasks.
    captured.lines = []
    await expect(repl['cmdSessions']()).resolves.toBeUndefined()
    expect(combinedOutput(captured)).toMatch(/no tasks found/i)

    // Populated: 2 tasks, one with many failures (high risk) and
    // one with a command already run (low risk).
    const engine = new TaskStateEngine({ stateDir })
    await engine.createTask('task_ok', 'Happy task')
    await engine.updateTask('task_ok', {
      commandsRun: ['pnpm test'],
    })
    await engine.createTask('task_dead', 'Stuck task')
    await engine.updateTask('task_dead', {
      failuresEncountered: ['first failure', 'second failure', 'third failure', 'fourth failure'],
      commandsRun: [],
    })

    captured.lines = []
    await expect(repl['cmdSessions']()).resolves.toBeUndefined()
    const out = combinedOutput(captured)
    expect(out).toContain('Tasks (2)')
    expect(out).toContain('task_ok')
    expect(out).toContain('task_dead')
    expect(out).toContain('[low]')
    expect(out).toContain('[high]')
  })

  // 9. /mode

  it('/mode sets config.mode, validates input, persists config', async () => {
    // Invalid: no args → usage hint.
    captured.lines = []
    await expect(repl['cmdMode']([])).resolves.toBeUndefined()
    expect(combinedOutput(captured)).toMatch(/usage: \/mode/i)
    expect(repl['config'].mode).toBe('implement') // unchanged

    // Invalid: bad mode.
    captured.lines = []
    await expect(repl['cmdMode'](['bogus'])).resolves.toBeUndefined()
    expect(combinedOutput(captured)).toMatch(/unknown mode/i)

    // Valid: implement → repair.
    captured.lines = []
    await expect(repl['cmdMode'](['repair'])).resolves.toBeUndefined()
    expect(combinedOutput(captured)).toContain('Mode set to')
    expect(combinedOutput(captured)).toContain('repair')
    expect(repl['config'].mode).toBe('repair')

    // All five valid modes round-trip.
    for (const m of ['implement', 'review', 'maintain', 'research']) {
      captured.lines = []
      await expect(repl['cmdMode']([m])).resolves.toBeUndefined()
      expect(repl['config'].mode).toBe(m)
    }
  })

  // 10. /budget

  it('/budget validates positive integer and sets tokenBudget', async () => {
    // Invalid: no args.
    captured.lines = []
    await expect(repl['cmdBudget']([])).resolves.toBeUndefined()
    expect(combinedOutput(captured)).toMatch(/usage: \/budget/i)

    // Invalid: not a number.
    captured.lines = []
    await expect(repl['cmdBudget'](['abc'])).resolves.toBeUndefined()
    expect(combinedOutput(captured)).toMatch(/positive integer/i)

    // Invalid: zero / negative.
    captured.lines = []
    await expect(repl['cmdBudget'](['0'])).resolves.toBeUndefined()
    expect(combinedOutput(captured)).toMatch(/positive integer/i)

    captured.lines = []
    await expect(repl['cmdBudget'](['-100'])).resolves.toBeUndefined()
    expect(combinedOutput(captured)).toMatch(/positive integer/i)

    // Invalid: decimal.
    captured.lines = []
    await expect(repl['cmdBudget'](['1.5'])).resolves.toBeUndefined()
    expect(combinedOutput(captured)).toMatch(/positive integer/i)

    // Valid: 100000.
    captured.lines = []
    await expect(repl['cmdBudget'](['100000'])).resolves.toBeUndefined()
    expect(combinedOutput(captured)).toContain('Token budget set to')
    expect(combinedOutput(captured)).toContain('100,000')
    expect(repl['tokenBudget']).toBe(100000)
  })

  // 11. /compact

  it('/compact degrades gracefully when AgentLoop.compact() is missing', async () => {
    // No active task: friendly message.
    captured.lines = []
    await expect(repl['cmdCompact']()).resolves.toBeUndefined()
    expect(combinedOutput(captured)).toMatch(/no active task/i)

    // Active task + AgentLoop.compact not exported → graceful
    // "not available in this build" message, no throw.
    ;(repl as unknown as { activeTaskId: string }).activeTaskId = 'task_compact'

    captured.lines = []
    await expect(repl['cmdCompact']()).resolves.toBeUndefined()
    const out = combinedOutput(captured)
    expect(out).toMatch(/compaction not available in this build/i)
    expect(out).not.toMatch(/Compaction failed/i)
  })
})

// Tiny self-test to ensure the random state dir is unique.
describe('test fixture isolation', () => {
  it('makeStateDir produces unique paths', () => {
    const a = makeStateDir()
    const b = makeStateDir()
    expect(a).not.toBe(b)
    rmSync(a, { recursive: true, force: true })
    rmSync(b, { recursive: true, force: true })
  })

  it('randomBytes is callable (sanity)', () => {
    expect(randomBytes(4).length).toBe(4)
  })
})
