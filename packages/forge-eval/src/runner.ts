import { cp, mkdtemp, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { AgentLoop, type AgentResult, type AgentConfig } from '@forge/agent'
import type { ProviderConfig, GitConfig } from '@forge/types'

export interface ComparisonOptions {
  /** The engineering task to run. */
  task: string
  /** Path to the fixture repo to copy and operate on. */
  fixtureDir: string
  /** LLM provider config (API key resolved from env by the provider layer). */
  provider: ProviderConfig
  mode?: 'explore' | 'implement' | 'repair' | 'review' | 'maintain' | 'research'
  maxIterations?: number
  /** Where to write the JSON report. */
  reportPath?: string
}

export interface ArmResult {
  label: string
  runtimeMs: number
  result: AgentResult
}

export interface ComparisonReport {
  task: string
  forge: ArmResult
  flat: ArmResult
  generatedAt: string
}

const GIT_OFF: GitConfig = { autoBranch: false, autoCommit: false, pr: 'off', branchPrefix: 'forge/' }

/** Copy the fixture into a fresh temp dir and initialize a git repo there. */
async function setupWorkdir(fixtureDir: string, label: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `forge-eval-${label}-`))
  await cp(fixtureDir, dir, { recursive: true })
  try {
    execFileSync('git', ['init', '-q'], { cwd: dir })
    execFileSync('git', ['config', 'user.email', 'eval@forge.local'], { cwd: dir })
    execFileSync('git', ['config', 'user.name', 'Forge Eval'], { cwd: dir })
    execFileSync('git', ['add', '-A'], { cwd: dir })
    execFileSync('git', ['commit', '-qm', 'fixture baseline'], { cwd: dir })
  } catch {
    // git is optional for the eval; metrics come from durable state either way.
  }
  return dir
}

async function runArm(
  label: string,
  workDir: string,
  opts: ComparisonOptions,
  features: AgentConfig['features'],
): Promise<ArmResult> {
  const agent = new AgentLoop({
    provider: opts.provider,
    workDir,
    stateDir: join(workDir, '.forge'),
    mode: opts.mode ?? 'implement',
    maxIterations: opts.maxIterations ?? 40,
    features,
    git: GIT_OFF,
  })
  await agent.buildRepoIntelligence()
  const start = Date.now()
  const result = await agent.run(opts.task)
  return { label, runtimeMs: Date.now() - start, result }
}

/**
 * Run the same task twice — once with the full Forge harness, once with a
 * "flat" baseline (no semantic fabric, no ledgers) — to make the AGENTS.md
 * claim measurable: same model, same repo, same task, better harness.
 */
export async function runComparison(opts: ComparisonOptions): Promise<ComparisonReport> {
  const forgeDir = await setupWorkdir(opts.fixtureDir, 'forge')
  const flatDir = await setupWorkdir(opts.fixtureDir, 'flat')

  const forge = await runArm('forge (full harness)', forgeDir, opts, {
    repoGraph: true,
    domainSystem: true,
    evidenceLedger: true,
    failureLedger: true,
    decisionLedger: true,
    checkpointSystem: true,
    trace: true,
  })

  const flat = await runArm('flat (baseline)', flatDir, opts, {
    repoGraph: false,
    domainSystem: false,
    evidenceLedger: false,
    failureLedger: false,
    decisionLedger: false,
    checkpointSystem: false,
    trace: false,
  })

  const report: ComparisonReport = { task: opts.task, forge, flat, generatedAt: new Date().toISOString() }

  if (opts.reportPath) {
    await mkdir(join(opts.reportPath, '..'), { recursive: true }).catch(() => {})
    await writeFile(opts.reportPath, JSON.stringify(report, null, 2), 'utf-8')
  }
  return report
}

/** Format a comparison report as a side-by-side metrics table. */
export function formatReport(report: ComparisonReport): string {
  const rows: [string, (a: ArmResult) => string | number][] = [
    ['status', (a) => a.result.status],
    ['iterations', (a) => a.result.iterations],
    ['files touched', (a) => a.result.filesTouched.length],
    ['commands run', (a) => a.result.commandsRun.length],
    ['evidence entries', (a) => a.result.evidenceCount],
    ['decisions', (a) => a.result.decisionCount],
    ['failures recorded', (a) => a.result.failureCount],
    ['verification passed', (a) => String(a.result.verificationPassed)],
    ['acceptance passed', (a) => String(a.result.acceptancePassed)],
    ['risk level', (a) => a.result.riskLevel ?? '—'],
    ['runtime (s)', (a) => (a.runtimeMs / 1000).toFixed(1)],
  ]
  const col = (s: string | number, w: number) => String(s).padEnd(w)
  const lines: string[] = []
  lines.push('')
  lines.push(`Task: ${report.task}`)
  lines.push('')
  lines.push(`${col('metric', 22)}${col('forge', 22)}flat`)
  lines.push('─'.repeat(60))
  for (const [name, fn] of rows) {
    lines.push(`${col(name, 22)}${col(fn(report.forge), 22)}${fn(report.flat)}`)
  }
  lines.push('')
  return lines.join('\n')
}
