/**
 * Tests for the 8 minimal CLI commands in `packages/forge-cli/src/commands/`.
 *
 * Strategy
 * --------
 * Each command exports a `run*(parsed: ParsedArgs) → Promise<CommandResult<T>>`
 * function. We import those directly and assert on the structured
 * `result` — no spawning of the CLI, no `process.exit` mocking. This
 * keeps the tests hermetic, fast, and parallelisable.
 *
 * For each command we test:
 *   1. `--text` (default) returns `textLines` and the right `exitCode`
 *   2. `--json` returns a structured `data` payload
 *   3. Error paths (missing args, unknown ids) set `ok: false` + the
 *      right `exitCode`
 *
 * Isolation
 * ---------
 * We point `FORGE_STATE_DIR` at a per-test temp directory so the
 * commands don't touch the real `.forge/` next to the test cwd.
 * `afterEach` cleans up.
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { mkdtemp, rm, writeFile, readFile, mkdir, access } from 'node:fs/promises'
import { existsSync, constants as FS } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  runInit,
  runRun,
  runSessions,
  runStatus,
  runVerify,
  runEvidence,
  runCheckpoint,
  runDoctor,
  parseArgs,
  emit,
  type CommandResult,
} from '@forge/cli/commands'
import { TaskStateEngine, EvidenceLedgerEngine } from '@forge/state'
import { VerificationMatrixEngine, CheckpointManager } from '@forge/verification'
import { tmpStateDir, cleanup } from './helpers.js'

// ── helpers ───────────────────────────────────────────────────

const originalStateDir = process.env.FORGE_STATE_DIR
const originalDatabaseUrl = process.env.FORGE_DATABASE_URL
const originalWorkdir = process.cwd()
const testRoot = join(tmpdir(), 'forge-cli-commands-test')

const dirs: string[] = []

async function withIsolatedStateDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'forge-cli-commands-'))
  dirs.push(d)
  process.env.FORGE_STATE_DIR = d
  // Unset DB so doctor + init skip Postgres unless the test sets it.
  delete process.env.FORGE_DATABASE_URL
  return d
}

async function withForcedDbUrl(url: string): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'forge-cli-commands-'))
  dirs.push(d)
  process.env.FORGE_STATE_DIR = d
  process.env.FORGE_DATABASE_URL = url
  return d
}

beforeEach(async () => {
  // Ensure a clean root for any test that may need to read .env
  if (!existsSync(testRoot)) await mkdir(testRoot, { recursive: true })
})

afterEach(async () => {
  // Restore env so other tests don't inherit our state dir.
  if (originalStateDir === undefined) delete process.env.FORGE_STATE_DIR
  else process.env.FORGE_STATE_DIR = originalStateDir
  if (originalDatabaseUrl === undefined) delete process.env.FORGE_DATABASE_URL
  else process.env.FORGE_DATABASE_URL = originalDatabaseUrl
  // Restore cwd in case any test changed it.
  process.chdir(originalWorkdir)
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

function captureStdout(fn: () => void): string {
  const orig = process.stdout.write.bind(process.stdout)
  let buf = ''
  // @ts-expect-error — we only need to capture the .write call signature
  process.stdout.write = (chunk: string | Buffer): boolean => {
    buf += typeof chunk === 'string' ? chunk : chunk.toString('utf-8')
    return true
  }
  try {
    fn()
  } finally {
    process.stdout.write = orig
  }
  return buf
}

function captureStderr(fn: () => void): string {
  const orig = process.stderr.write.bind(process.stderr)
  let buf = ''
  // @ts-expect-error
  process.stderr.write = (chunk: string | Buffer): boolean => {
    buf += typeof chunk === 'string' ? chunk : chunk.toString('utf-8')
    return true
  }
  try {
    fn()
  } finally {
    process.stderr.write = orig
  }
  return buf
}

// ── parseArgs helper ──────────────────────────────────────────

describe('parseArgs', () => {
  it('parses --json flag', () => {
    const p = parseArgs(['--json', 'hello'])
    expect(p.json).toBe(true)
    expect(p.text).toBe(false)
    expect(p.positional).toEqual(['hello'])
  })

  it('parses --text flag and short flags', () => {
    const p = parseArgs(['--text', '--claim', 'ev-1'])
    expect(p.text).toBe(true)
    expect(p.options.get('claim')).toBe('ev-1')
  })

  it('parses --flag=value form', () => {
    const p = parseArgs(['--status=open', 't1'])
    expect(p.options.get('status')).toBe('open')
    expect(p.positional).toEqual(['t1'])
  })

  it('treats bare --flag as boolean true', () => {
    // --claim (no value following) should land in options as 'true'
    const p = parseArgs(['t1', '--claim'])
    expect(p.options.get('claim')).toBe('true')
    expect(p.positional).toEqual(['t1'])
  })
})

// ── runInit ───────────────────────────────────────────────────

describe('runInit', () => {
  it('is idempotent: second call reports configExisted=true', async () => {
    await withIsolatedStateDir()
    const r1 = await runInit(parseArgs([]))
    expect(r1.ok).toBe(true)
    expect(r1.exitCode).toBe(0)
    expect(r1.data?.configExisted).toBe(false)

    const r2 = await runInit(parseArgs([]))
    expect(r2.ok).toBe(true)
    expect(r2.data?.configExisted).toBe(true)
  })

  it('writes .env and patches .gitignore', async () => {
    await withIsolatedStateDir()
    // Switch cwd to the test root so the .env + .gitignore live there.
    const d = await mkdtemp(join(tmpdir(), 'forge-cli-init-'))
    dirs.push(d)
    process.chdir(d)

    const result = await runInit(parseArgs(['--json']))
    expect(result.ok).toBe(true)
    expect(result.data?.envCreated).toBe(true)
    expect(existsSync(join(d, '.env'))).toBe(true)
    const envContent = await readFile(join(d, '.env'), 'utf-8')
    expect(envContent).toContain('FORGE_DATABASE_URL=')
    expect(existsSync(join(d, '.gitignore'))).toBe(true)
    const gi = await readFile(join(d, '.gitignore'), 'utf-8')
    expect(gi).toContain('.forge/')
    expect(gi).toContain('.env')
  })

  it('skips Postgres init when FORGE_DATABASE_URL is unset', async () => {
    await withIsolatedStateDir()
    const result = await runInit(parseArgs([]))
    expect(result.ok).toBe(true)
    expect(result.data?.postgres.reachable).toBe(false)
    expect(result.data?.postgres.error).toBeUndefined()
  })

  it('emits --json via the dispatcher', async () => {
    await withIsolatedStateDir()
    const result = await runInit(parseArgs(['--json']))
    const out = captureStdout(() => emit(result, parseArgs(['--json'])))
    expect(() => JSON.parse(out.trimEnd())).not.toThrow()
    const parsed = JSON.parse(out.trimEnd())
    expect(parsed.ok).toBe(true)
    expect(parsed.data).toBeDefined()
    expect(parsed.data.stateDir).toBeTruthy()
  })

  it('emits --text via the dispatcher', async () => {
    await withIsolatedStateDir()
    const result = await runInit(parseArgs([]))
    const out = captureStdout(() => emit(result, parseArgs([])))
    expect(out).toContain('Initialized Forge at')
    expect(out).toContain('FORGE_DATABASE_URL')
  })
})

// ── runRun ────────────────────────────────────────────────────

describe('runRun', () => {
  it('returns exitCode=1 when no task is provided', async () => {
    await withIsolatedStateDir()
    const result = await runRun(parseArgs([]))
    expect(result.ok).toBe(false)
    expect(result.exitCode).toBe(1)
    expect(result.textLines?.[0]).toContain('no task provided')
  })

  it('returns exitCode=1 when --file is missing', async () => {
    await withIsolatedStateDir()
    const result = await runRun(parseArgs(['--file', '/no/such/file/abc.md']))
    expect(result.ok).toBe(false)
    expect(result.exitCode).toBe(1)
    expect(result.textLines?.[0]).toContain('cannot read --file')
  })

  it('blocks normal runs when Postgres is not configured', async () => {
    await withIsolatedStateDir()
    process.chdir(originalWorkdir)
    const { initConfig } = await import('@forge/cli/config')
    await initConfig()
    const result = await runRun(parseArgs(['--json', 'summarize the repo']))
    expect(result.ok).toBe(false)
    expect(result.exitCode).toBe(1)
    expect(result.textLines?.join('\n')).toContain('Postgres is required')
  })

  it('allows explicit degraded file-mode runs', async () => {
    await withIsolatedStateDir()
    process.chdir(originalWorkdir)
    const { initConfig } = await import('@forge/cli/config')
    await initConfig()
    const result = await runRun(parseArgs(['--state-mode=file', '--allow-no-local', '--json', 'summarize the repo']))
    expect([0, 2]).toContain(result.exitCode)
    expect(result.data).toBeDefined()
  })
})

// ── runSessions ───────────────────────────────────────────────

describe('runSessions', () => {
  it('returns an empty list when no tasks exist', async () => {
    await withIsolatedStateDir()
    const result = await runSessions(parseArgs([]))
    expect(result.ok).toBe(true)
    expect(result.exitCode).toBe(0)
    expect(result.data?.count).toBe(0)
    expect(result.data?.tasks).toEqual([])
  })

  it('lists all tasks in the file state engine', async () => {
    const d = await withIsolatedStateDir()
    const engine = new TaskStateEngine({ stateDir: d })
    await engine.createTask('aaa', 'first task')
    await engine.createTask('bbb', 'second task')
    await engine.addFileTouched('aaa', 'src/a.ts')

    const result = await runSessions(parseArgs(['--json']))
    expect(result.ok).toBe(true)
    expect(result.data?.count).toBe(2)
    const ids = result.data?.tasks.map((t) => t.taskId).sort()
    expect(ids).toEqual(['aaa', 'bbb'])
    const a = result.data?.tasks.find((t) => t.taskId === 'aaa')
    expect(a?.filesTouched).toBe(1)
    expect(a?.currentInterpretation).toBe('first task')
  })

  it('--text mode prints human-readable lines', async () => {
    const d = await withIsolatedStateDir()
    const engine = new TaskStateEngine({ stateDir: d })
    await engine.createTask('t1', 'a sample task')
    const result = await runSessions(parseArgs([]))
    const out = captureStdout(() => emit(result, parseArgs([])))
    expect(out).toContain('Tasks (1):')
    expect(out).toContain('t1')
  })
})

// ── runStatus ─────────────────────────────────────────────────

describe('runStatus', () => {
  it('returns exitCode=1 when no tasks exist and no id given', async () => {
    await withIsolatedStateDir()
    const result = await runStatus(parseArgs([]))
    expect(result.ok).toBe(false)
    expect(result.exitCode).toBe(1)
    expect(result.textLines?.[0]).toContain('No tasks found')
  })

  it('returns exitCode=1 when a specific id is unknown', async () => {
    await withIsolatedStateDir()
    const result = await runStatus(parseArgs(['nope']))
    expect(result.ok).toBe(false)
    expect(result.exitCode).toBe(1)
  })

  it('returns the requested task summary', async () => {
    const d = await withIsolatedStateDir()
    const engine = new TaskStateEngine({ stateDir: d })
    await engine.createTask('xyz', 'do the X thing')
    await engine.addFileTouched('xyz', 'src/x.ts')
    await engine.addSubtask('xyz', { id: 's1', label: 'first', status: 'completed' })
    const result = await runStatus(parseArgs(['xyz']))
    expect(result.ok).toBe(true)
    expect(result.data?.taskId).toBe('xyz')
    expect(result.data?.filesTouched).toEqual(['src/x.ts'])
    expect(result.data?.subtasks).toEqual([{ id: 's1', status: 'completed', label: 'first' }])
  })

  it('--json emits parseable JSON with taskId', async () => {
    const d = await withIsolatedStateDir()
    const engine = new TaskStateEngine({ stateDir: d })
    await engine.createTask('abc', 'json task')
    const result = await runStatus(parseArgs(['abc', '--json']))
    const out = captureStdout(() => emit(result, parseArgs(['--json'])))
    const parsed = JSON.parse(out.trimEnd())
    expect(parsed.ok).toBe(true)
    expect(parsed.data.taskId).toBe('abc')
  })
})

// ── runVerify ─────────────────────────────────────────────────

describe('runVerify', () => {
  it('returns exitCode=1 when taskId is missing', async () => {
    await withIsolatedStateDir()
    const result = await runVerify(parseArgs([]))
    expect(result.ok).toBe(false)
    expect(result.exitCode).toBe(1)
  })

  it('returns an empty matrix for an unknown task', async () => {
    await withIsolatedStateDir()
    const result = await runVerify(parseArgs(['ghost']))
    expect(result.ok).toBe(true)
    expect(result.data?.openCount).toBe(0)
    expect(result.data?.entries).toEqual([])
  })

  it('filters by --status (default open)', async () => {
    const d = await withIsolatedStateDir()
    const vm = new VerificationMatrixEngine({ stateDir: d })
    await vm.addEntry('t1', 'tests pass', { status: 'passed' })
    await vm.addEntry('t1', 'lint clean', { status: 'failed' })
    await vm.addEntry('t1', 'docs ok', { status: 'unverified' })
    const result = await runVerify(parseArgs(['t1']))
    expect(result.data?.entries).toHaveLength(2)
    const failedOnly = await runVerify(parseArgs(['t1', '--status', 'failed']))
    expect(failedOnly.data?.entries).toHaveLength(1)
    expect(failedOnly.data?.entries[0]?.check).toBe('lint clean')
  })

  it('--json emits summary + entries', async () => {
    const d = await withIsolatedStateDir()
    const vm = new VerificationMatrixEngine({ stateDir: d })
    await vm.addEntry('t1', 'unit', { status: 'passed' })
    await vm.addEntry('t1', 'integration', { status: 'failed' })
    const result = await runVerify(parseArgs(['t1', '--json']))
    const out = captureStdout(() => emit(result, parseArgs(['--json'])))
    const parsed = JSON.parse(out.trimEnd())
    expect(parsed.data.summary.failed).toBe(1)
    expect(parsed.data.summary.passed).toBe(1)
  })
})

// ── runEvidence ───────────────────────────────────────────────

describe('runEvidence', () => {
  it('returns exitCode=1 when taskId is missing', async () => {
    await withIsolatedStateDir()
    const result = await runEvidence(parseArgs([]))
    expect(result.ok).toBe(false)
    expect(result.exitCode).toBe(1)
  })

  it('returns summary + entries for a known task', async () => {
    const d = await withIsolatedStateDir()
    const e = new EvidenceLedgerEngine({ stateDir: d })
    await e.addEntry('t1', 'auth works', 'observation', { evidence: ['test:auth passes'] })
    await e.addEntry('t1', 'maybe works', 'inferred')
    const result = await runEvidence(parseArgs(['t1']))
    expect(result.ok).toBe(true)
    expect(result.data?.summary.total).toBe(2)
    expect(result.data?.summary.verified).toBe(1)
    expect(result.data?.entries).toHaveLength(2)
  })

  it('--claim returns one entry or fails cleanly', async () => {
    const d = await withIsolatedStateDir()
    const e = new EvidenceLedgerEngine({ stateDir: d })
    await e.addEntry('t1', 'first claim', 'observation')
    const first = await e.getLedger('t1')
    const entryId = first!.entries[0]!.id

    const ok = await runEvidence(parseArgs(['t1', '--claim', entryId]))
    expect(ok.ok).toBe(true)
    expect(ok.data?.entry?.id).toBe(entryId)
    expect(ok.data?.entry?.claim).toBe('first claim')

    const miss = await runEvidence(parseArgs(['t1', '--claim', 'no-such-id']))
    expect(miss.ok).toBe(false)
    expect(miss.exitCode).toBe(1)
  })

  it('--json emits entries array', async () => {
    const d = await withIsolatedStateDir()
    const e = new EvidenceLedgerEngine({ stateDir: d })
    await e.addEntry('t1', 'claim A', 'observation')
    const result = await runEvidence(parseArgs(['t1', '--json']))
    const out = captureStdout(() => emit(result, parseArgs(['--json'])))
    const parsed = JSON.parse(out.trimEnd())
    expect(parsed.data.entries).toHaveLength(1)
    expect(parsed.data.entries[0].claim).toBe('claim A')
  })
})

// ── runCheckpoint ─────────────────────────────────────────────

describe('runCheckpoint', () => {
  it('returns exitCode=1 when taskId is missing', async () => {
    await withIsolatedStateDir()
    const result = await runCheckpoint(parseArgs([]))
    expect(result.ok).toBe(false)
    expect(result.exitCode).toBe(1)
  })

  it('returns empty checkpoints + patches for a fresh task', async () => {
    await withIsolatedStateDir()
    const result = await runCheckpoint(parseArgs(['fresh']))
    expect(result.ok).toBe(true)
    expect(result.data?.checkpoints).toEqual([])
    expect(result.data?.patches).toEqual([])
    expect(result.data?.promoted).toBeUndefined()
    expect(result.data?.failed).toEqual([])
  })

  it('returns checkpoint + patch candidates after creation', async () => {
    const d = await withIsolatedStateDir()
    const cm = new CheckpointManager({ stateDir: d, workDir: d })
    const cp = await cm.createCheckpoint('t1', 'try Y', ['src/a.ts'], 'hypothesis: Y works')
    const patch = await cm.createPatch('t1', cp.id, 'try Y', 'diff --git', [
      { path: 'src/a.ts', additions: 1, deletions: 0 },
    ])
    await cm.addTestResults('t1', patch.id, [{ name: 't', passed: 1, failed: 0, durationMs: 5 }])
    await cm.promotePatch('t1', patch.id)

    const result = await runCheckpoint(parseArgs(['t1']))
    expect(result.ok).toBe(true)
    expect(result.data?.checkpoints).toHaveLength(1)
    expect(result.data?.patches).toHaveLength(1)
    expect(result.data?.promoted?.id).toBe(patch.id)
    expect(result.data?.failed).toEqual([])
  })
})

// ── runDoctor ─────────────────────────────────────────────────

describe('runDoctor', () => {
  it('reports env state when FORGE_DATABASE_URL is unset', async () => {
    await withIsolatedStateDir()
    const result = await runDoctor(parseArgs(['--json']))
    expect(result.ok).toBe(true) // unset DB is non-fatal
    expect(result.data?.databaseUrlPresent).toBe(false)
    expect(result.data?.postgres.ok).toBe(false)
    expect(result.data?.postgres.detail).toContain('FORGE_DATABASE_URL')
  })

  it('marks driver as installed when postgres is on the classpath', async () => {
    await withIsolatedStateDir()
    const result = await runDoctor(parseArgs([]))
    expect(result.data?.driver.ok).toBe(true)
  })

  it('redacts the password in the JSON payload', async () => {
    await withForcedDbUrl('postgres://u:hunter2@host/db')
    // The probe will fail (host unreachable) but redaction must still occur.
    const result = await runDoctor(parseArgs(['--json']))
    expect(result.data?.databaseUrlRedacted).toBe('postgres://u:***@host/db')
  })

  it('--text mode prints per-probe lines', async () => {
    await withIsolatedStateDir()
    const result = await runDoctor(parseArgs([]))
    const out = captureStdout(() => emit(result, parseArgs([])))
    expect(out).toContain('Forge doctor')
    expect(out).toContain('driver:')
    expect(out).toContain('postgres:')
  })
})

// ── end-to-end: parseArgs + emit round-trip ───────────────────

describe('parseArgs + emit round-trip', () => {
  it('runs through runSessions and round-trips as JSON', async () => {
    const d = await withIsolatedStateDir()
    const engine = new TaskStateEngine({ stateDir: d })
    await engine.createTask('rt', 'round-trip task')
    const argv = ['--json']
    const parsed = parseArgs(argv)
    expect(parsed.json).toBe(true)
    const result = await runSessions(parsed)
    const out = captureStdout(() => emit(result, parsed))
    const json = JSON.parse(out.trimEnd())
    expect(json.ok).toBe(true)
    expect(json.data.count).toBe(1)
    expect(json.data.tasks[0].taskId).toBe('rt')
  })

  it('text mode stays as plain text (not JSON)', async () => {
    const d = await withIsolatedStateDir()
    const engine = new TaskStateEngine({ stateDir: d })
    await engine.createTask('txt', 'text mode task')
    const parsed = parseArgs([])
    expect(parsed.json).toBe(false)
    const result = await runSessions(parsed)
    const out = captureStdout(() => emit(result, parsed))
    expect(out).toContain('Tasks (1):')
    expect(out).not.toMatch(/^\s*\{/)
  })
})
