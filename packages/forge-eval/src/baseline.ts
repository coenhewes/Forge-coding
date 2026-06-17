/**
 * BaselineComparison — runs the same eval task on two arms (Forge full
 * harness vs flat baseline) and computes the seven metrics called out in
 * AGENTS.md §33 and the parent task brief:
 *
 *   1. verified_completion_rate
 *   2. cost_per_completed_task
 *   3. runtime_per_completed_task
 *   4. irrelevant_files_edited
 *   5. repeated_failed_attempts
 *   6. human_interventions
 *   7. resume_success_rate
 *
 * The class wraps the existing `runComparison` helper from `./runner.js`
 * so we reuse the same worktree setup, fixture copy, and feature-flag
 * plumbing. We then enrich each arm's `AgentResult` with the metrics
 * the brief requires and persist a structured JSON report.
 *
 * Results can be wired back into `forge-belief`'s assurance case via the
 * `appendBaselineAssurance` helper — the PR generator can reference
 * baseline improvement in its claim-evidence summary.
 */

import { cp, mkdtemp, writeFile, mkdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { execFileSync } from 'node:child_process'

import { AgentLoop } from '@forge/agent'
import type { AgentConfig, AgentResult } from '@forge/agent'
import type { ProviderConfig, GitConfig } from '@forge/types'

import { runComparison as runRawComparison } from './runner.js'
import type { ArmResult } from './runner.js'
import type { EvalTask, EvalMetricWeights } from './tasks.js'
import { DEFAULT_METRIC_WEIGHTS } from './tasks.js'

const GIT_OFF: GitConfig = { autoBranch: false, autoCommit: false, pr: 'off', branchPrefix: 'forge/' }

// ─── Metric data model ────────────────────────────────────────────────────

/** A single arm's enriched result: AgentResult + derived metrics + raw artifacts. */
export interface ComparisonArmMetrics {
  label: string
  task: EvalTask
  workDir: string
  runtimeMs: number
  result: AgentResult
  /** Acceptance checks executed against the post-run worktree. */
  acceptanceResults: AcceptanceCheckResult[]
  /** Did every required acceptance check pass? */
  verifiedCompletion: boolean
  /** Fraction of acceptance checks that passed (0..1). */
  verifiedFraction: number
  /** Estimated LLM cost in USD. Uses provider/model heuristically. */
  estimatedCostUsd: number
  /** Files edited that did not match `expectedTouchedPatterns` (heuristic). */
  irrelevantFilesEdited: string[]
  /** Number of repeated identical (hypothesis, action) attempts. */
  repeatedFailedAttempts: number
  /** Number of explicit human-approval / human-input prompts the agent emitted. */
  humanInterventions: number
  /** Whether the run resumed cleanly from a prior crashed session. */
  resumed: boolean
}

export interface AcceptanceCheckResult {
  id: string
  description: string
  status: 'passed' | 'failed' | 'skipped' | 'not_applicable' | 'blocked'
  durationMs: number
  exitCode?: number
  stdoutTail?: string
  stderrTail?: string
  reason?: string
}

export interface ComparisonReport {
  task: EvalTask
  forge: ComparisonArmMetrics
  flat: ComparisonArmMetrics
  /** Per-task metric delta: forge minus flat (positive = forge better). */
  deltas: ComparisonDeltas
  /** Weighted overall score (0..1) — higher is better. */
  forgeScore: number
  flatScore: number
  /** Relative improvement: (forgeScore - flatScore) / max(flatScore, eps). */
  improvement: number
  generatedAt: string
  /** Path to the JSON file we wrote (relative to cwd). */
  reportPath?: string
}

export interface ComparisonDeltas {
  verified_completion_rate: number
  cost_per_completed_task: number
  runtime_per_completed_task: number
  irrelevant_files_edited: number
  repeated_failed_attempts: number
  human_interventions: number
  resume_success_rate: number
}

export interface BaselineComparisonOptions {
  task: EvalTask
  /** Fixture directory to copy for each arm. */
  fixtureDir: string
  /** Provider config (model, temperature, max tokens). */
  provider: ProviderConfig
  mode?: AgentConfig['mode']
  maxIterations?: number
  /** Optional override of metric weights. Defaults to task.weights ?? DEFAULT. */
  weights?: EvalMetricWeights
  /** Optional path to write the JSON report. */
  reportPath?: string
  /** When true, skip the LLM run entirely and synthesize fake results (used in tests). */
  dryRun?: boolean
}

// ─── Cost estimation ──────────────────────────────────────────────────────

/**
 * Very rough per-model cost table (USD per 1M tokens, in + out blended).
 * Replace with a real pricing module if/when we have one. Values are
 * deliberately conservative so they compare like-for-like across arms.
 */
const MODEL_COST_PER_1M: Record<string, number> = {
  'minimax-m3': 1.0,
  'claude-3-5-sonnet-latest': 3.0,
  'gpt-4o': 2.5,
  'gpt-4o-mini': 0.15,
}

function estimateCostUsd(provider: ProviderConfig, iterations: number, filesTouched: number): number {
  const key = `${provider.name}/${provider.model}`
  const per1m = MODEL_COST_PER_1M[provider.model] ?? 1.0
  // Heuristic: ~4k in + ~1k out tokens per iteration, +1k per file touched.
  const tokens = iterations * 5000 + filesTouched * 1000
  return (tokens / 1_000_000) * per1m
}

// ─── Worktree helpers ─────────────────────────────────────────────────────

async function setupWorkdir(fixtureDir: string, label: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `forge-eval-baseline-${label}-`))
  await cp(fixtureDir, dir, { recursive: true })
  try {
    execFileSync('git', ['init', '-q'], { cwd: dir })
    execFileSync('git', ['config', 'user.email', 'eval@forge.local'], { cwd: dir })
    execFileSync('git', ['config', 'user.name', 'Forge Eval'], { cwd: dir })
    execFileSync('git', ['add', '-A'], { cwd: dir })
    execFileSync('git', ['commit', '-qm', 'fixture baseline'], { cwd: dir })
  } catch {
    /* git is optional */
  }
  return dir
}

async function applySeed(workDir: string, seed: EvalTask['seed']): Promise<void> {
  if (!seed) return
  if (seed.brokenFile) {
    const target = join(workDir, seed.brokenFile.path)
    await mkdir(join(target, '..'), { recursive: true })
    await writeFile(target, seed.brokenFile.content, 'utf-8')
  }
  if (seed.createFile) {
    const target = join(workDir, seed.createFile.path)
    await mkdir(join(target, '..'), { recursive: true })
    await writeFile(target, seed.createFile.content, 'utf-8')
  }
  // applyPatch (unified diff) intentionally omitted — keep scope tight.
}

function detectRepeatedFailedAttempts(failureCount: number, commandsRun: string[]): number {
  // Heuristic: when failure count exceeds the number of distinct commands,
  // the agent repeated an identical action. Count the excess.
  const distinct = new Set(commandsRun).size
  return Math.max(0, failureCount - distinct)
}

// ─── Acceptance check execution ───────────────────────────────────────────

async function runAcceptanceCheck(
  workDir: string,
  check: NonNullable<EvalTask['acceptance']>[number],
): Promise<AcceptanceCheckResult> {
  const start = Date.now()
  if (check.expectedFiles) {
    for (const rel of check.expectedFiles) {
      try {
        await readFile(join(workDir, rel), 'utf-8')
      } catch {
        return {
          id: check.id,
          description: check.description,
          status: 'failed',
          durationMs: Date.now() - start,
          reason: `Missing expected file: ${rel}`,
        }
      }
    }
    return { id: check.id, description: check.description, status: 'passed', durationMs: Date.now() - start }
  }
  if (check.command) {
    try {
      const out = execFileSync('sh', ['-c', check.command], { cwd: workDir, encoding: 'utf-8' })
      return {
        id: check.id,
        description: check.description,
        status: 'passed',
        durationMs: Date.now() - start,
        exitCode: 0,
        stdoutTail: out.slice(-512),
      }
    } catch (err) {
      const e = err as { status?: number; stdout?: string; stderr?: string; message?: string }
      return {
        id: check.id,
        description: check.description,
        status: 'failed',
        durationMs: Date.now() - start,
        exitCode: e.status ?? 1,
        stdoutTail: (e.stdout ?? '').slice(-512),
        stderrTail: (e.stderr ?? '').slice(-512),
        reason: e.message,
      }
    }
  }
  return {
    id: check.id,
    description: check.description,
    status: 'not_applicable',
    durationMs: Date.now() - start,
    reason: 'No command or expectedFiles set',
  }
}

async function runAllAcceptanceChecks(workDir: string, task: EvalTask): Promise<AcceptanceCheckResult[]> {
  return Promise.all(task.acceptance.map((c) => runAcceptanceCheck(workDir, c)))
}

// ─── Single-arm runner ────────────────────────────────────────────────────

async function runOneArm(
  label: string,
  workDir: string,
  opts: BaselineComparisonOptions,
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
  const result = await agent.run(opts.task.prompt)
  return { label, runtimeMs: Date.now() - start, result }
}

function synthesizeArm(task: EvalTask, label: string, completed: boolean, ms: number): ArmResult {
  return {
    label,
    runtimeMs: ms,
    result: {
      taskId: `synthetic-${task.id}`,
      status: completed ? 'verified_complete' : 'incomplete',
      summary: `Synthetic ${label} result for ${task.id}`,
      iterations: completed ? 12 : 40,
      filesTouched: completed
        ? ['src/auth/permissions.ts', 'src/api/invites.ts', 'tests/auth/invite.test.ts']
        : ['README.md'],
      commandsRun: completed
        ? ['pnpm typecheck', 'pnpm test', 'pnpm lint']
        : ['pnpm test'],
      evidenceCount: completed ? 4 : 0,
      failureCount: completed ? 1 : 12,
      decisionCount: completed ? 2 : 0,
      verificationPassed: completed,
      acceptancePassed: completed,
      riskLevel: task.risk,
    } satisfies AgentResult,
  }
}

// ─── Metric computation ───────────────────────────────────────────────────

function computeMetrics(
  arm: ArmResult,
  workDir: string,
  task: EvalTask,
  provider: ProviderConfig,
  acceptanceResults: AcceptanceCheckResult[],
): ComparisonArmMetrics {
  const verifiedFraction =
    acceptanceResults.length === 0
      ? arm.result.verificationPassed
        ? 1
        : 0
      : acceptanceResults.filter((r) => r.status === 'passed').length / acceptanceResults.length

  const irrelevantFilesEdited = arm.result.filesTouched.filter((f) => {
    const patterns = task.acceptance
      .flatMap((c) => c.expectedTouchedPatterns ?? [])
      .map((p) => p.replace(/\*\*/g, ''))
    if (patterns.length === 0) return false
    return !patterns.some((p) => f.includes(p))
  })

  return {
    label: arm.label,
    task,
    workDir,
    runtimeMs: arm.runtimeMs,
    result: arm.result,
    acceptanceResults,
    verifiedCompletion: verifiedFraction === 1,
    verifiedFraction,
    estimatedCostUsd: Number(
      estimateCostUsd(provider, arm.result.iterations, arm.result.filesTouched.length).toFixed(4),
    ),
    irrelevantFilesEdited,
    repeatedFailedAttempts: detectRepeatedFailedAttempts(
      arm.result.failureCount,
      arm.result.commandsRun,
    ),
    humanInterventions: arm.result.failureCount > 5 ? 0 : 0, // placeholder: agent loop does not yet expose this
    resumed: arm.result.resumed ?? false,
  }
}

// ─── Score composition ────────────────────────────────────────────────────

function composeScore(metrics: ComparisonArmMetrics, weights: Required<EvalMetricWeights>): number {
  const v = metrics.verifiedFraction
  const cost = Math.min(1, metrics.estimatedCostUsd / 1.0) // $1 → 1.0
  const runtime = Math.min(1, metrics.runtimeMs / (10 * 60 * 1000)) // 10 min → 1.0
  const irrelevant = Math.min(1, metrics.irrelevantFilesEdited.length / 10)
  const repeated = Math.min(1, metrics.repeatedFailedAttempts / 5)
  const human = Math.min(1, metrics.humanInterventions / 3)
  const resume = metrics.resumed ? 1 : 0

  // Each component is "better when lower" except verifiedFraction and resume.
  const costScore = 1 - cost
  const runtimeScore = 1 - runtime
  const irrelevantScore = 1 - irrelevant
  const repeatedScore = 1 - repeated
  const humanScore = 1 - human

  return (
    weights.verified_completion_rate * v +
    weights.cost_per_completed_task * costScore +
    weights.runtime_per_completed_task * runtimeScore +
    weights.irrelevant_files_edited * irrelevantScore +
    weights.repeated_failed_attempts * repeatedScore +
    weights.human_interventions * humanScore +
    weights.resume_success_rate * resume
  )
}

function computeDeltas(
  forge: ComparisonArmMetrics,
  flat: ComparisonArmMetrics,
): ComparisonDeltas {
  return {
    verified_completion_rate: forge.verifiedFraction - flat.verifiedFraction,
    cost_per_completed_task: flat.estimatedCostUsd - forge.estimatedCostUsd,
    runtime_per_completed_task: flat.runtimeMs - forge.runtimeMs,
    irrelevant_files_edited: flat.irrelevantFilesEdited.length - forge.irrelevantFilesEdited.length,
    repeated_failed_attempts: flat.repeatedFailedAttempts - forge.repeatedFailedAttempts,
    human_interventions: flat.humanInterventions - forge.humanInterventions,
    resume_success_rate: (forge.resumed ? 1 : 0) - (flat.resumed ? 1 : 0),
  }
}

// ─── Public API ───────────────────────────────────────────────────────────

export class BaselineComparison {
  readonly options: BaselineComparisonOptions
  private readonly weights: Required<EvalMetricWeights>

  constructor(options: BaselineComparisonOptions) {
    this.options = options
    this.weights = { ...DEFAULT_METRIC_WEIGHTS, ...(options.task.weights ?? {}), ...(options.weights ?? {}) }
  }

  /** Run the comparison and return a structured report. */
  async run(): Promise<ComparisonReport> {
    const { task, fixtureDir, provider } = this.options

    const forgeDir = await setupWorkdir(fixtureDir, 'forge')
    const flatDir = await setupWorkdir(fixtureDir, 'flat')

    await applySeed(forgeDir, task.seed)
    await applySeed(flatDir, task.seed)

    let forgeArm: ArmResult
    let flatArm: ArmResult

    if (this.options.dryRun) {
      // Delegate to runComparison's dryRun branch — that path synthesizes
      // both arms without constructing a provider or making LLM calls.
      const dryReport = await runRawComparison({
        task: task.prompt,
        fixtureDir,
        provider,
        mode: this.options.mode ?? 'implement',
        maxIterations: this.options.maxIterations ?? 40,
        dryRun: true,
      })
      forgeArm = dryReport.forge
      flatArm = dryReport.flat
    } else {
      // Use the existing raw comparison so we reuse the worktree + LLM plumbing.
      const raw = await runRawComparison({
        task: task.prompt,
        fixtureDir,
        provider,
        mode: this.options.mode ?? 'implement',
        maxIterations: this.options.maxIterations ?? 40,
      })
      // Re-run with seeds applied by re-copying the seeded dirs.
      // (We avoid duplicating the worktree code by re-running here.)
      forgeArm = await runOneArm('forge (full harness)', forgeDir, this.options, {
        repoGraph: true,
        domainSystem: true,
        evidenceLedger: true,
        failureLedger: true,
        decisionLedger: true,
        checkpointSystem: true,
        trace: true,
      })
      flatArm = await runOneArm('flat (baseline)', flatDir, this.options, {
        repoGraph: false,
        domainSystem: false,
        evidenceLedger: false,
        failureLedger: false,
        decisionLedger: false,
        checkpointSystem: false,
        trace: false,
      })
      // Suppress unused warning for `raw`.
      void raw
    }

    const [forgeChecks, flatChecks] = await Promise.all([
      this.options.dryRun ? Promise.resolve([]) : runAllAcceptanceChecks(forgeDir, task),
      this.options.dryRun ? Promise.resolve([]) : runAllAcceptanceChecks(flatDir, task),
    ])

    const forgeMetrics = computeMetrics(forgeArm, forgeDir, task, provider, forgeChecks)
    const flatMetrics = computeMetrics(flatArm, flatDir, task, provider, flatChecks)

    const forgeScore = composeScore(forgeMetrics, this.weights)
    const flatScore = composeScore(flatMetrics, this.weights)
    const improvement = (forgeScore - flatScore) / Math.max(flatScore, 1e-6)

    const report: ComparisonReport = {
      task,
      forge: forgeMetrics,
      flat: flatMetrics,
      deltas: computeDeltas(forgeMetrics, flatMetrics),
      forgeScore,
      flatScore,
      improvement,
      generatedAt: new Date().toISOString(),
      reportPath: this.options.reportPath,
    }

    if (this.options.reportPath) {
      await mkdir(join(this.options.reportPath, '..'), { recursive: true }).catch(() => {})
      await writeFile(this.options.reportPath, JSON.stringify(report, null, 2), 'utf-8')
      await appendBaselineAssurance(report)
    }

    return report
  }
}

// ─── Wiring back into forge-belief ────────────────────────────────────────

import { join as pathJoin } from 'node:path'

const BELIEF_BRIDGE_DIR = '.forge/baseline-reports'

/**
 * Persist the comparison report inside the worktree so the PR generator
 * (Track 6) can pick it up as part of the assurance case. The PR layer
 * already scans `.forge/baseline-reports/*.json` and renders a
 * "Baseline improvement" section when present.
 */
export async function appendBaselineAssurance(report: ComparisonReport): Promise<void> {
  const dir = pathJoin(report.forge.workDir, BELIEF_BRIDGE_DIR)
  await mkdir(dir, { recursive: true })
  const summary = {
    taskId: report.task.id,
    taskClass: report.task.cls,
    title: report.task.title,
    forgeScore: report.forgeScore,
    flatScore: report.flatScore,
    improvement: report.improvement,
    verifiedCompletionRateDelta: report.deltas.verified_completion_rate,
    costDeltaUsd: report.deltas.cost_per_completed_task,
    runtimeDeltaMs: report.deltas.runtime_per_completed_task,
    irrelevantFilesDelta: report.deltas.irrelevant_files_edited,
    repeatedFailedAttemptsDelta: report.deltas.repeated_failed_attempts,
    humanInterventionsDelta: report.deltas.human_interventions,
    resumeSuccessRateDelta: report.deltas.resume_success_rate,
    generatedAt: report.generatedAt,
  }
  const target = pathJoin(dir, `${report.task.id}.json`)
  await writeFile(target, JSON.stringify(summary, null, 2), 'utf-8')
}

// ─── Side-by-side formatting for the CLI ──────────────────────────────────

export function formatComparisonTable(report: ComparisonReport): string {
  const col = (s: string | number, w: number) => String(s).padEnd(w)
  const w1 = 28
  const w2 = 16
  const w3 = 16
  const rows: Array<[string, string | number, string | number, string | number]> = [
    ['metric', 'forge', 'flat', 'delta (forge-flat)'],
    [
      'verified_completion_rate',
      report.forge.verifiedFraction.toFixed(2),
      report.flat.verifiedFraction.toFixed(2),
      signed(report.deltas.verified_completion_rate.toFixed(2)),
    ],
    [
      'cost_per_completed_task (USD)',
      report.forge.estimatedCostUsd.toFixed(4),
      report.flat.estimatedCostUsd.toFixed(4),
      signed(report.deltas.cost_per_completed_task.toFixed(4)),
    ],
    [
      'runtime_per_completed_task (ms)',
      report.forge.runtimeMs.toFixed(0),
      report.flat.runtimeMs.toFixed(0),
      signed(report.deltas.runtime_per_completed_task.toFixed(0)),
    ],
    [
      'irrelevant_files_edited',
      report.forge.irrelevantFilesEdited.length,
      report.flat.irrelevantFilesEdited.length,
      signed(report.deltas.irrelevant_files_edited),
    ],
    [
      'repeated_failed_attempts',
      report.forge.repeatedFailedAttempts,
      report.flat.repeatedFailedAttempts,
      signed(report.deltas.repeated_failed_attempts),
    ],
    [
      'human_interventions',
      report.forge.humanInterventions,
      report.flat.humanInterventions,
      signed(report.deltas.human_interventions),
    ],
    [
      'resume_success_rate',
      report.forge.resumed ? '1' : '0',
      report.flat.resumed ? '1' : '0',
      signed(report.deltas.resume_success_rate),
    ],
    [
      'weighted_score',
      report.forgeScore.toFixed(3),
      report.flatScore.toFixed(3),
      signed(report.improvement.toFixed(3)) + ' rel.',
    ],
  ]
  const lines: string[] = []
  lines.push('')
  lines.push(`Task: ${report.task.id} — ${report.task.title}`)
  lines.push(`Class: ${report.task.cls}`)
  lines.push('')
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!
    if (i === 1) lines.push('─'.repeat(w1 + w2 + w3 + 24))
    if (i === 0) {
      lines.push(`${col(r[0], w1)}${col(r[1], w2)}${col(r[2], w3)}${col(r[3], 24)}`)
    } else {
      lines.push(`${col(r[0], w1)}${col(r[1], w2)}${col(r[2], w3)}${col(r[3], 24)}`)
    }
  }
  lines.push('')
  return lines.join('\n')
}

function signed(n: string | number): string {
  const v = typeof n === 'number' ? n : Number(n)
  return v > 0 ? `+${n}` : `${n}`
}

// Re-export for convenience (the CLI imports from this module).
export { runRawComparison }
export type { ArmResult }

// Relative-path helper for tests that want to assert "did not touch file X".
export function isWithinTouched(rel: string, touched: string[]): boolean {
  return touched.some((t) => relative('.', rel).startsWith(t) || rel.includes(t))
}