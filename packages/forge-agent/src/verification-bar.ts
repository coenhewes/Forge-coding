/**
 * Verification bar — the objective "production-ready" checks that back the
 * done-gate. A criterion can only be marked `verified` once the checks it
 * requires have passing evidence here (not on the model's say-so).
 *
 * Checks (auto-detected from the repo):
 *   - test       — the project's test command
 *   - typecheck  — `tsc --noEmit` (or a `typecheck` script)
 *   - build      — the build command
 *   - boot       — the start/dev command actually starts without crashing
 *
 * All checks are bounded (timeouts) and never throw to the caller — they return
 * a structured result so the agent loop stays resumable.
 */
import { execSync } from 'node:child_process'
import { spawn } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

import type { VerificationCheckKind } from '@forge/types'

export type RunnableCheck = Exclude<VerificationCheckKind, 'e2e'>

export interface CheckResult {
  kind: RunnableCheck
  command: string
  passed: boolean
  output: string
}

const DEFAULT_TIMEOUT_MS = 180_000
const BOOT_WAIT_MS = 8_000
const BOOT_READY_RE = /listening|ready|started|running on|server.*\b\d{2,5}\b|localhost:\d+/i
const BOOT_ERROR_RE = /error|exception|cannot find|EADDRINUSE|unhandled|throw/i

/** Detect a runnable command per check kind from package.json + repo layout. */
export function detectChecks(workDir: string): Record<RunnableCheck, string | null> {
  let scripts: Record<string, string> = {}
  const pkgPath = join(workDir, 'package.json')
  if (existsSync(pkgPath)) {
    try {
      scripts = (JSON.parse(readFileSync(pkgPath, 'utf-8')).scripts ?? {}) as Record<string, string>
    } catch {
      scripts = {}
    }
  }
  const has = (name: string) => typeof scripts[name] === 'string' && scripts[name]!.trim().length > 0
  const hasTsconfig = existsSync(join(workDir, 'tsconfig.json'))

  return {
    test: has('test') ? 'npm test' : null,
    typecheck: has('typecheck') ? 'npm run typecheck' : hasTsconfig ? 'npx tsc --noEmit' : null,
    build: has('build') ? 'npm run build' : null,
    boot: has('start') ? 'npm start' : has('dev') ? 'npm run dev' : has('serve') ? 'npm run serve' : null,
  }
}

function runCommandCheck(kind: RunnableCheck, workDir: string, command: string): CheckResult {
  try {
    const out = execSync(command, { cwd: workDir, encoding: 'utf-8', timeout: DEFAULT_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'] })
    return { kind, command, passed: true, output: (out || '').trim().slice(-4000) || '(no output)' }
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; message?: string }
    const output = `${e.stdout ?? ''}\n${e.stderr ?? ''}`.trim() || e.message || 'check failed'
    return { kind, command, passed: false, output: output.slice(-4000) }
  }
}

/**
 * Boot check: start the server, watch its output for a readiness signal, and
 * treat "stayed up for BOOT_WAIT_MS without crashing or erroring" as success.
 * Always kills the child afterward.
 */
function runBootCheck(workDir: string, command: string): Promise<CheckResult> {
  return new Promise((resolve) => {
    const child = spawn(command, { cwd: workDir, shell: true, detached: true })
    let out = ''
    let settled = false
    const finish = (passed: boolean, note: string) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL')
      } catch {
        child.kill('SIGKILL')
      }
      resolve({ kind: 'boot', command, passed, output: `${note}\n${out}`.trim().slice(-4000) })
    }
    child.stdout?.on('data', (d) => {
      out += d.toString()
      if (BOOT_READY_RE.test(out)) finish(true, 'boot: detected readiness signal')
    })
    child.stderr?.on('data', (d) => {
      out += d.toString()
      if (BOOT_ERROR_RE.test(out)) finish(false, 'boot: error in startup output')
    })
    child.on('exit', (code) => finish(code === 0, `boot: process exited early with code ${code}`))
    child.on('error', (e) => finish(false, `boot: failed to start (${e.message})`))
    const timer = setTimeout(() => finish(true, `boot: stayed up ${BOOT_WAIT_MS}ms without crashing`), BOOT_WAIT_MS)
  })
}

/** Run the requested checks (default: all detected). Skips checks with no command. */
export async function runVerification(
  workDir: string,
  kinds?: RunnableCheck[],
): Promise<CheckResult[]> {
  const detected = detectChecks(workDir)
  const wanted = kinds ?? (Object.keys(detected) as RunnableCheck[])
  const results: CheckResult[] = []
  for (const kind of wanted) {
    const command = detected[kind]
    if (!command) continue
    results.push(kind === 'boot' ? await runBootCheck(workDir, command) : runCommandCheck(kind, workDir, command))
  }
  return results
}
