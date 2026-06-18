#!/usr/bin/env node

import {
  runInit,
  runRun,
  runSessions,
  runStatus,
  runVerify,
  runEvidence,
  runCheckpoint,
  runDoctor,
  runProviders,
  parseArgs,
  emit,
} from './commands/index.js'
import { loadConfig, initConfig } from './config.js'
import { TaskStateEngine } from '@forge/state'
import { AgentLoop } from '@forge/agent'
import { ForgeStateStore, defaultStateStoreConfig } from '@forge/state-store'
import { mcp } from '@forge/integrations'
import { Dashboard, ConfigWizard, Repl } from '@forge/tui'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The 8 minimal CLI commands per the t50b brief. Each is a
 * (parsedArgs) → Promise<CommandResult> function exported from
 * `./commands/*.js`. Tests import them directly; the CLI
 * dispatcher (this file) routes argv through them.
 */
const COMMANDS: Record<string, (parsed: import('./commands/output.js').ParsedArgs) => Promise<import('./commands/output.js').CommandResult<unknown>>> = {
  init: runInit as (p: import('./commands/output.js').ParsedArgs) => Promise<import('./commands/output.js').CommandResult<unknown>>,
  run: runRun as (p: import('./commands/output.js').ParsedArgs) => Promise<import('./commands/output.js').CommandResult<unknown>>,
  sessions: runSessions as (p: import('./commands/output.js').ParsedArgs) => Promise<import('./commands/output.js').CommandResult<unknown>>,
  status: runStatus as (p: import('./commands/output.js').ParsedArgs) => Promise<import('./commands/output.js').CommandResult<unknown>>,
  verify: runVerify as (p: import('./commands/output.js').ParsedArgs) => Promise<import('./commands/output.js').CommandResult<unknown>>,
  evidence: runEvidence as (p: import('./commands/output.js').ParsedArgs) => Promise<import('./commands/output.js').CommandResult<unknown>>,
  checkpoint: runCheckpoint as (p: import('./commands/output.js').ParsedArgs) => Promise<import('./commands/output.js').CommandResult<unknown>>,
  doctor: runDoctor as (p: import('./commands/output.js').ParsedArgs) => Promise<import('./commands/output.js').CommandResult<unknown>>,
  providers: runProviders as (p: import('./commands/output.js').ParsedArgs) => Promise<import('./commands/output.js').CommandResult<unknown>>,
}

async function main() {
  const argv = process.argv.slice(2)
  const command = argv[0] as string | undefined
  const rest = argv.slice(1)

  switch (command) {
    case 'init':
    case 'run':
    case 'sessions':
    case 'status':
    case 'verify':
    case 'evidence':
    case 'checkpoint':
    case 'doctor': {
      const parsed = parseArgs(rest)
      const handler = COMMANDS[command as string]
      if (!handler) {
        console.error(`Unknown command: ${command}`)
        process.exit(1)
        return
      }
      const result = await handler(parsed)
      emit(result, parsed)
      process.exit(result.exitCode)
      return
    }
    // Legacy aliases — kept for back-compat. `tasks` is the old name
    // for what the brief now calls `sessions`.
    case 'tasks':
      await cmdTasks(rest)
      return
    case 'resume':
      await cmdResume(rest)
      return
    case 'dashboard':
      await cmdDashboard(rest)
      return
    case 'setup':
      await cmdSetup()
      return
    case 'state':
      await cmdState(rest)
      return
    case 'mcp':
      await cmdMcp(rest)
      return
    case 'help':
    case '--help':
    case '-h':
      showHelp()
      return
    case undefined:
    default:
      await cmdRepl()
      return
  }
}

function showHelp() {
  console.log(`
Forge — Long-horizon software engineering agent

Minimal commands (each supports --json / --text):
  forge init                      Idempotent setup (.env, state store, .gitignore)
  forge run <task>                Run a task via the agent loop
  forge sessions                  List all tasks in the state store
  forge status [taskId]           Show summary for a single task (or the most recent)
  forge verify <taskId>           List the open verification matrix
  forge evidence <taskId>         List the evidence ledger (--claim <id> for one)
  forge checkpoint <taskId>       List patch candidates and checkpoints
  forge doctor                    Env + DB + provider reachability check
  forge providers <list|test>     List supported LLM providers, or probe one

Advanced:
  forge resume <taskId> [answer]  Resume a paused/blocked task
  forge tasks                     Alias for \`forge sessions\` (legacy)
  forge dashboard [taskId]        Launch TUI dashboard
  forge setup                     Run setup wizard in TUI
  forge state migrate             Apply state-store migrations to FORGE_DATABASE_URL
  forge doctor [--migrate]        Check Forge env; --migrate also runs migrations
  forge mcp serve                 Run the Forge MCP server on stdio (JSON-RPC 2.0)
  forge mcp list                  Spawn the MCP server and list advertised tools
  forge help                      Show this help
`)
}

// ── Legacy commands (kept for back-compat with existing scripts) ──

async function cmdTasks(args: string[]) {
  void args
  const parsed = parseArgs([])
  const result = await runSessions(parsed)
  emit(result, parsed)
  process.exit(result.exitCode)
}

async function cmdResume(args: string[]) {
  const taskId = args[0]
  if (!taskId) {
    console.error('Error: task ID required. Usage: forge resume <taskId> [your answer]')
    process.exit(1)
  }
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
  if (task.filesTouched.length > 0) console.log(`Files already touched: ${task.filesTouched.length}`)

  const openQuestion = task.openQuestions.find((q) => !q.resolved)
  if (answer && openQuestion) {
    await engine.resolveQuestion(taskId, openQuestion.question, answer)
    console.log(`Recorded answer to: ${openQuestion.question}`)
  }

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

async function cmdState(args: string[]) {
  const subcommand = args[0]
  if (subcommand === 'migrate') {
    await cmdStateMigrate()
    return
  }
  console.error('Usage: forge state migrate')
  process.exit(1)
}

async function cmdStateMigrate(): Promise<void> {
  const connectionString = process.env.FORGE_DATABASE_URL
  if (!connectionString) {
    console.error('Error: FORGE_DATABASE_URL is not set.')
    console.error('Set it in your shell or .env, then retry.')
    process.exit(1)
  }
  const rootDir = join(tmpdir(), `forge-migrate-${process.pid}`)
  const store = new ForgeStateStore({ config: defaultStateStoreConfig(rootDir, connectionString) })
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

async function cmdMcp(args: string[]): Promise<void> {
  const subcommand = args[0]
  if (subcommand === 'serve') {
    const code = await mcp.runMcpServeFromEnv()
    process.exit(code)
  }
  if (subcommand === 'list') {
    await cmdMcpList()
    return
  }
  console.error('Usage: forge mcp <serve|list>')
  process.exit(1)
}

async function cmdMcpList(): Promise<void> {
  const cliEntry = process.argv[1] ?? 'forge'
  const client = mcp.spawnStdioMcpClient({
    command: process.execPath,
    args: [cliEntry, 'mcp', 'serve'],
    cwd: process.cwd(),
    responseTimeoutMs: 15_000,
  })
  try {
    const tools = await client.listTools()
    console.log(`MCP server exposes ${tools.length} tool(s):`)
    for (const tool of tools) {
      console.log(`  - ${tool.name}`)
      console.log(`      ${tool.description}`)
    }
  } catch (err) {
    console.error('forge mcp list failed:', err instanceof Error ? err.message : String(err))
    process.exit(2)
  } finally {
    await client.close()
  }
}

async function getConfig(): Promise<import('@forge/types').ForgeConfig> {
  const config = await loadConfig()
  if (!config) {
    console.log('Forge is not initialized. Run: forge init')
    console.log('Using default configuration.')
    const cfg = await initConfig()
    return cfg
  }
  return config
}

main().catch((err) => {
  console.error('Error:', err instanceof Error ? err.message : String(err))
  process.exit(1)
})
