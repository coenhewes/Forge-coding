#!/usr/bin/env node

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { loadConfig, initConfig, isInitialized, DEFAULT_CONFIG, DEFAULT_STATE_DIR } from './config.js'
import { formatTaskStatus, formatContract, formatVerification } from './status.js'
import { TaskStateEngine, AcceptanceContractEngine, EvidenceLedgerEngine, FailureLedgerEngine, DecisionLedgerEngine } from '@forge/state'
import { VerificationMatrixEngine, CheckpointManager } from '@forge/verification'
import { AgentLoop } from '@forge/agent'
import { ForgeStateStore, defaultStateStoreConfig } from '@forge/state-store'
import type { ForgeConfig, ForgeConfigFile } from '@forge/types'
import { Dashboard, ConfigWizard, Repl } from '@forge/tui'

async function main() {
  const args = process.argv.slice(2)
  const command = args[0]

  switch (command) {
    case 'init':
      await cmdInit(args.slice(1))
      break
    case 'run':
      await cmdRun(args.slice(1))
      break
    case 'status':
      await cmdStatus(args.slice(1))
      break
    case 'resume':
      await cmdResume(args.slice(1))
      break
    case 'tasks':
      await cmdTasks()
      break
    case 'checkpoint':
      await cmdCheckpoint(args.slice(1))
      break
    case 'evidence':
      await cmdEvidence(args.slice(1))
      break
    case 'dashboard':
      await cmdDashboard(args.slice(1))
      break
    case 'setup':
      await cmdSetup()
      break
    case 'state':
      await cmdState(args.slice(1))
      break
    case 'doctor':
      await cmdDoctor(args.slice(1))
      break
    case 'help':
      showHelp()
      break
    default:
      await cmdRepl()
      break
  }
}

function showHelp() {
  console.log(`
Forge — Long-horizon software engineering agent

Usage:
  forge init                   Initialize .forge/config.json
  forge run <task>             Run a task
  forge run --file <path>      Run task from file
  forge status [taskId]        Show task status
  forge resume <taskId>        Resume a paused/blocked task
  forge tasks                  List all tasks
  forge checkpoint <taskId>    Show checkpoints for a task
  forge evidence <taskId>      Show evidence ledger for a task
  forge dashboard [taskId]     Launch TUI dashboard
  forge setup                  Run setup wizard in TUI
  forge state migrate          Apply state-store migrations to FORGE_DATABASE_URL
  forge doctor [--migrate]     Check Forge environment; --migrate also runs migrations
  forge help                   Show this help
`)
}

async function cmdInit(args: string[]) {
  const providerArg = parseArg(args, '--provider')
  const modelArg = parseArg(args, '--model')

  const overrides: Partial<ForgeConfigFile> = {}
  if (providerArg && modelArg) {
    overrides.provider = {
      ...DEFAULT_CONFIG.provider,
      name: providerArg as any,
      model: modelArg,
    }
  }

  const config = await initConfig(overrides)
  console.log(`Initialized Forge at ${config.stateDir}`)
  console.log(`Provider: ${config.provider.name} (${config.provider.model})`)
  console.log(`Mode: ${config.mode}`)
}

async function cmdRun(args: string[]) {
  const filePath = parseArg(args, '--file')
  let task: string

  if (filePath) {
    task = await readFile(resolve(filePath), 'utf-8')
  } else {
    task = args.join(' ').trim()
  }

  if (!task) {
    console.error('Error: no task provided. Use: forge run <task> or forge run --file <path>')
    process.exit(1)
  }

  const config = await getConfig()

  console.log(`\nForge — Running task\n`)
  console.log(`Provider: ${config.provider.name} (${config.provider.model})`)
  console.log(`Mode: ${config.mode}`)
  console.log(`Work dir: ${config.workDir}`)
  console.log(`State dir: ${config.stateDir}`)
  console.log('')

  const agent = new AgentLoop({
    provider: config.provider,
    workDir: config.workDir,
    stateDir: config.stateDir,
    mode: config.mode,
    maxIterations: 50,
    features: config.features,
    git: config.git,
  })

  // Build repo intelligence first
  console.log('[1/5] Scanning repository...')
  await agent.buildRepoIntelligence()

  console.log('[2/5] Routing task to domains...')
  console.log('[3/5] Creating acceptance contract...')
  console.log('[4/5] Selecting affected tests...')
  console.log('[5/5] Entering agent loop...')
  console.log('')

  const result = await agent.run(task)

  console.log('\n─── Result ───')
  console.log(`Status: ${result.status}`)
  console.log(`Iterations: ${result.iterations}`)
  console.log(`Files touched: ${result.filesTouched.length}`)
  console.log(`Commands run: ${result.commandsRun.length}`)
  console.log(`Evidence: ${result.evidenceCount} entries`)
  console.log(`Failures: ${result.failureCount} recorded`)
  console.log(`Decisions: ${result.decisionCount} recorded`)
  console.log(`Verification passed: ${result.verificationPassed}`)
  console.log(`Acceptance passed: ${result.acceptancePassed}`)
  if (result.riskLevel) console.log(`Risk level: ${result.riskLevel}`)
  console.log(`Summary: ${result.summary}`)

  if (result.promotedCheckpointId) {
    console.log(`Promoted checkpoint: ${result.promotedCheckpointId}`)
  }

  if (result.branch) console.log(`Branch: ${result.branch}`)
  if (result.commitSha) console.log(`Commit: ${result.commitSha}`)
  if (result.prUrl) console.log(`PR: ${result.prUrl}`)
  else if (result.prPath) console.log(`PR body: ${result.prPath}`)

  if (result.status === 'blocked') {
    console.log('\n⚠ Task is blocked waiting for your input.')
    console.log(`  Use: forge resume ${result.taskId}`)
  }

  console.log(`\nTask ID: ${result.taskId}`)
  console.log('')
}

async function cmdStatus(args: string[]) {
  const config = await getConfig()
  const taskId = args[0]
  const engine = new TaskStateEngine({ stateDir: config.stateDir })

  if (taskId) {
    const task = await engine.getTask(taskId)
    if (!task) {
      console.error(`Task not found: ${taskId}`)
      process.exit(1)
    }
    console.log(formatTaskStatus(task))

    // Show acceptance contract
    const acceptance = new AcceptanceContractEngine({ stateDir: config.stateDir })
    const contract = await acceptance.getContract(taskId)
    if (contract) {
      console.log('')
      console.log(formatContract(contract))
    }

    // Show verification matrix
    const verification = new VerificationMatrixEngine({ stateDir: config.stateDir })
    const entries = await verification.getEntries(taskId)
    if (entries.length > 0) {
      console.log('')
      console.log(formatVerification(entries))
    }
  } else {
    const tasks = await engine.listTasks()
    if (tasks.length === 0) {
      console.log('No tasks found.')
      return
    }
    console.log('Tasks:')
    for (const id of tasks) {
      const t = await engine.getTask(id)
      if (t) {
        console.log(`  ${t.status === 'completed' ? '✓' : '○'} ${id} — ${t.status} — ${t.currentInterpretation.slice(0, 80)}`)
      }
    }
  }
}

async function cmdResume(args: string[]) {
  const taskId = args[0]
  if (!taskId) {
    console.error('Error: task ID required. Usage: forge resume <taskId> [your answer]')
    process.exit(1)
  }
  // Everything after the taskId is treated as the human's answer to the
  // question that blocked the task.
  const answer = args.slice(1).join(' ').trim()

  const config = await getConfig()

  const engine = new TaskStateEngine({ stateDir: config.stateDir })
  const task = await engine.getTask(taskId)
  if (!task) {
    console.error(`Task not found: ${taskId}`)
    process.exit(1)
  }

  await engine.resumeTask(taskId)

  console.log(`Resuming task: ${taskId}`)
  console.log(`Previous status: ${task.status}`)
  console.log(`Previous next action: ${task.nextAction}`)
  if (task.filesTouched.length > 0) {
    console.log(`Files already touched: ${task.filesTouched.length}`)
  }

  // Resolve the first open question with the provided answer, if any.
  const openQuestion = task.openQuestions.find((q) => !q.resolved)
  if (answer && openQuestion) {
    await engine.resolveQuestion(taskId, openQuestion.question, answer)
    console.log(`Recorded answer to: ${openQuestion.question}`)
  }

  // Re-inject prior progress + the human decision so the continued run picks up
  // where it left off instead of starting cold.
  const resumeContext = buildResumeContext(task, answer)

  const agent = new AgentLoop({
    provider: config.provider,
    workDir: config.workDir,
    stateDir: config.stateDir,
    mode: config.mode,
    maxIterations: 50,
    features: config.features,
    git: config.git,
  })

  await agent.buildRepoIntelligence()
  const result = await agent.run(resumeContext)

  console.log('\n─── Resume Result ───')
  console.log(`Status: ${result.status}`)
  console.log(`Iterations: ${result.iterations}`)
  console.log(`Summary: ${result.summary}`)
}

/** Compose a continuation prompt from a blocked task's prior state + the human answer. */
function buildResumeContext(task: import('@forge/types').TaskState, answer: string): string {
  const parts = [task.originalRequest]
  if (task.completedWork.length > 0) {
    parts.push('\nWork already completed in a previous session:')
    parts.push(...task.completedWork.map((w) => `- ${w}`))
  }
  if (task.filesTouched.length > 0) {
    parts.push(`\nFiles already changed: ${task.filesTouched.join(', ')}`)
  }
  const openQuestion = task.openQuestions.find((q) => !q.resolved)
  if (answer && openQuestion) {
    parts.push(`\nYou previously asked: "${openQuestion.question}"`)
    parts.push(`The human answered: "${answer}"`)
    parts.push('Continue the task using this decision.')
  } else if (answer) {
    parts.push(`\nHuman guidance for continuing: "${answer}"`)
  }
  return parts.join('\n')
}

async function cmdTasks() {
  const config = await getConfig()
  const engine = new TaskStateEngine({ stateDir: config.stateDir })
  const tasks = await engine.listTasks()

  if (tasks.length === 0) {
    console.log('No tasks found.')
    return
  }

  console.log(`Tasks (${tasks.length}):`)
  for (const id of tasks) {
    const task = await engine.getTask(id)
    if (task) {
      const icon = task.status === 'completed' ? '✓' : task.status === 'failed' ? '✗' : task.status === 'blocked' ? '⚠' : '○'
      const subtaskProgress = task.subtasks.filter((s) => s.status === 'completed').length
      const subtaskTotal = task.subtasks.length
      const subtaskInfo = subtaskTotal > 0 ? ` [${subtaskProgress}/${subtaskTotal}]` : ''
      console.log(`  ${icon} ${id} — ${task.status}${subtaskInfo}`)
      console.log(`      ${task.currentInterpretation.slice(0, 100)}`)
    }
  }
}

async function cmdCheckpoint(args: string[]) {
  const taskId = args[0]
  if (!taskId) {
    console.error('Error: task ID required. Usage: forge checkpoint <taskId>')
    process.exit(1)
  }

  const config = await getConfig()
  const cm = new CheckpointManager({ stateDir: config.stateDir })
  const checkpoints = await cm.getCheckpointTree(taskId)

  if (checkpoints.length === 0) {
    console.log('No checkpoints found for this task.')
    return
  }

  console.log(`Checkpoints for ${taskId}:`)
  for (const cp of checkpoints) {
    const icon = cp.promotionDecision === 'promoted' ? '✓' : cp.promotionDecision === 'rejected' ? '✗' : '○'
    console.log(`  ${icon} ${cp.id} — ${cp.hypothesis}`)
    console.log(`      Files: ${cp.filesChanged.join(', ')}`)
    console.log(`      Reason: ${cp.reason}`)
    console.log(`      Verdict: ${cp.promotionDecision ?? 'pending'}`)
    if (cp.failureReason) console.log(`      Failure: ${cp.failureReason}`)
    console.log('')
  }

  // Show patches
  const { patches, promoted, failed } = await cm.comparePatches(taskId)
  if (patches.length > 0) {
    console.log(`Patch candidates: ${patches.length}`)
    console.log(`  Promoted: ${promoted ? promoted.id : 'none'}`)
    console.log(`  Failed: ${failed.length}`)
  }
}

async function cmdEvidence(args: string[]) {
  const taskId = args[0]
  if (!taskId) {
    console.error('Error: task ID required. Usage: forge evidence <taskId>')
    process.exit(1)
  }

  const config = await getConfig()
  const evidence = new EvidenceLedgerEngine({ stateDir: config.stateDir })
  const failures = new FailureLedgerEngine({ stateDir: config.stateDir })
  const decisions = new DecisionLedgerEngine({ stateDir: config.stateDir })

  const evidenceSummary = await evidence.getSummary(taskId)
  const failureEntries = await failures.getEntries(taskId)
  const decisionEntries = await decisions.getEntries(taskId)

  console.log(`\nEvidence Ledger for ${taskId}:`)
  console.log(`  Total: ${evidenceSummary.total}`)
  console.log(`  Verified: ${evidenceSummary.verified}`)
  console.log(`  Unverified: ${evidenceSummary.unverified}`)
  console.log(`  Needs review: ${evidenceSummary.needsReview}`)

  console.log(`\nFailure Ledger: ${failureEntries.length} entries`)
  for (const f of failureEntries.slice(-5)) {
    console.log(`  ✗ ${f.hypothesis} — ${f.lesson}`)
  }

  console.log(`\nDecision Ledger: ${decisionEntries.length} entries`)
  for (const d of decisionEntries.slice(-5)) {
    console.log(`  → ${d.decision}`)
  }
  console.log('')
}

async function cmdDashboard(args: string[]) {
  const taskId = args[0]
  const config = await loadConfig()
  const stateDir = config?.stateDir ?? '.forge'

  const dashboard = new Dashboard({ stateDir, initialTaskId: taskId })
  await dashboard.start()
}

async function cmdRepl() {
  const config = await getConfig()
  const repl = new Repl(config)
  await repl.start()
}

async function cmdSetup() {
  const wizard = new ConfigWizard()
  const result = await wizard.start()
  if (result.cancelled) {
    console.log('Setup cancelled.')
    return
  }
  console.log('Configuration saved to .forge/config.json')
  console.log(`  Provider: ${result.config.provider.name}`)
  console.log(`  Model:    ${result.config.provider.model}`)
}

/**
 * `forge state <subcommand>`. Today only `migrate` exists; later tracks
 * add `inspect`, `reset`, `backup`, etc. Each subcommand is responsible
 * for its own FORGE_DATABASE_URL discovery and error messages.
 */
async function cmdState(args: string[]) {
  const subcommand = args[0]
  if (subcommand === 'migrate') {
    await cmdStateMigrate()
    return
  }
  console.error('Usage: forge state migrate')
  process.exit(1)
}

/**
 * Apply state-store migrations to the database pointed at by
 * `FORGE_DATABASE_URL`. Idempotent — safe to run on every fresh checkout.
 *
 * Exit codes:
 *   0  success (whether or not any new migrations were applied)
 *   1  configuration error (FORGE_DATABASE_URL unset)
 *   2  migration runner error (Postgres unreachable, bad SQL, etc.)
 */
async function cmdStateMigrate(): Promise<void> {
  const connectionString = process.env.FORGE_DATABASE_URL
  if (!connectionString) {
    console.error('Error: FORGE_DATABASE_URL is not set.')
    console.error('Set it in your shell or .env, then retry.')
    process.exit(1)
  }

  // We don't need an artifact dir for migrations, but ForgeStateStore's
  // constructor requires one. Use a throwaway temp dir.
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const rootDir = join(tmpdir(), `forge-migrate-${process.pid}`)

  const store = new ForgeStateStore({
    config: defaultStateStoreConfig(rootDir, connectionString),
  })

  try {
    const applied = await store.runMigrations()
    if (applied.length === 0) {
      console.log('No new migrations to apply. Database is up to date.')
    } else {
      console.log(`Applied ${applied.length} migration(s): versions ${applied.join(', ')}`)
    }
  } catch (err) {
    console.error('Migration failed:', err instanceof Error ? err.message : String(err))
    process.exit(2)
  }
}

/**
 * `forge doctor` — quick environment health check.
 *
 * Today this only inspects Postgres reachability + migration state.
 * `--migrate` runs migrations after the check, which makes the command
 * a one-shot "make my database ready" entry point.
 */
async function cmdDoctor(args: string[]) {
  const migrate = args.includes('--migrate')
  const connectionString = process.env.FORGE_DATABASE_URL

  if (!connectionString) {
    console.log('FORGE_DATABASE_URL: not set')
    process.exit(1)
  }
  console.log(`FORGE_DATABASE_URL: set (${redactPassword(connectionString)})`)

  // Probe reachability. We don't need a real query, just a round-trip.
  const postgresModule = await import('postgres').catch(() => undefined)
  if (!postgresModule) {
    console.log('postgres driver: not installed (run `pnpm install`)')
    process.exit(1)
  }
  console.log('postgres driver: installed')

  const postgres =
    (postgresModule as { default?: unknown }).default ?? postgresModule
  const sql = (postgres as (cs: string) => {
    <T = unknown>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T>
    end(opts?: { timeout?: number }): Promise<void>
  })(connectionString)

  try {
    const result = await sql<[unknown]>`
      select 1 as ok
    `
    const row = result[0] as { ok?: number } | undefined
    console.log(`Postgres reachable: yes (select 1 → ${row?.ok ?? 'ok'})`)
  } catch (err) {
    console.log(
      `Postgres reachable: no (${err instanceof Error ? err.message : String(err)})`,
    )
    process.exit(1)
  } finally {
    await sql.end({ timeout: 5 })
  }

  if (migrate) {
    console.log('Running migrations...')
    await cmdStateMigrate()
  } else {
    console.log('Run `forge doctor --migrate` to apply pending migrations.')
  }
}

/** Mask the password in a postgres:// URL so we don't leak secrets in logs. */
function redactPassword(url: string): string {
  return url.replace(/(postgres(?:ql)?:\/\/[^:]+:)[^@]+(@)/, '$1***$2')
}

async function getConfig(): Promise<ForgeConfig> {
  const config = await loadConfig()
  if (!config) {
    console.log('Forge is not initialized. Run: forge init')
    console.log('Using default configuration.')
    const cfg = await initConfig()
    return cfg
  }
  return config
}

function parseArg(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name)
  if (idx >= 0 && idx < args.length - 1) {
    return args[idx + 1]
  }
  return undefined
}

main().catch((err) => {
  console.error('Error:', err instanceof Error ? err.message : String(err))
  process.exit(1)
})
