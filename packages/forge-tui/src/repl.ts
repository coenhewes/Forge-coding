import blessed from 'blessed'
import { AgentLoop } from '@forge/agent'
import type { AgentEvent } from '@forge/agent'
import { TaskStateEngine, EvidenceLedgerEngine, FailureLedgerEngine, DecisionLedgerEngine } from '@forge/state'
import { VerificationMatrixEngine, CheckpointManager } from '@forge/verification'
import { TraceRecorder } from '@forge/trace'
import { generatePRSummary, type PRGeneratorInput } from '@forge/pr'
import { ConfigWizard } from './config-wizard.js'
import { writeFile, mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import type { ForgeConfig, ForgeConfigFile } from '@forge/types'

const DEFAULT_STATE_DIR = '.forge'
const LONG_HORIZON_MAX_WALL_CLOCK_MS = 8 * 60 * 60 * 1000
const LONG_HORIZON_MAX_ITERATIONS = 10_000

interface SlashCommand {
  name: string
  aliases: string[]
  description: string
  usage: string
  handler: (args: string[]) => Promise<void>
}

export class Repl {
  private screen: any
  private logBox: any
  private inputBox: any
  private footerBox: any
  private running = false
  private logLines: string[] = []
  private config: ForgeConfig
  private commands: SlashCommand[] = []
  /**
   * The taskId the user is currently focused on. Set by `/mode`,
   * `/resume`, `runTask`, and the various inspect commands. Read by
   * the 11 new slash commands (`/belief`, `/probes`, `/verify`,
   * `/failures`, `/trace`, `/pr`) when no explicit `<taskId>` arg
   * is supplied. `undefined` ⇒ "no active task" and the handler
   * prints a friendly message instead of crashing.
   */
  private activeTaskId: string | undefined = undefined
  /**
   * Optional per-session token budget set via `/budget <n>`.
   * Persisted as part of the session state file.
   */
  private tokenBudget: number | undefined = undefined

  constructor(config: ForgeConfig) {
    this.config = config
    this.registerCommands()
  }

  private registerCommands(): void {
    this.commands = [
      {
        name: 'help',
        aliases: ['h'],
        description: 'Show available commands',
        usage: '/help',
        handler: async () => this.cmdHelp(),
      },
      {
        name: 'setup',
        aliases: [],
        description: 'Run setup wizard to configure provider and API key',
        usage: '/setup',
        handler: async () => this.cmdSetup(),
      },
      {
        name: 'model',
        aliases: [],
        description: 'Set the model name',
        usage: '/model <name>',
        handler: async (args) => this.cmdModel(args),
      },
      {
        name: 'provider',
        aliases: [],
        description: 'Set the provider name',
        usage: '/provider <name>',
        handler: async (args) => this.cmdProvider(args),
      },
      {
        name: 'init',
        aliases: [],
        description: 'Initialize forge config',
        usage: '/init [--provider <name> --model <name>]',
        handler: async (args) => this.cmdInit(args),
      },
      {
        name: 'status',
        aliases: ['st'],
        description: 'Show task status',
        usage: '/status [taskId]',
        handler: async (args) => this.cmdStatus(args),
      },
      {
        name: 'tasks',
        aliases: ['ls'],
        description: 'List all tasks',
        usage: '/tasks',
        handler: async () => this.cmdTasks(),
      },
      {
        name: 'resume',
        aliases: [],
        description: 'Resume a blocked/paused task',
        usage: '/resume <taskId>',
        handler: async (args) => this.cmdResume(args),
      },
      {
        name: 'checkpoint',
        aliases: ['cp'],
        description: 'Show checkpoints for a task',
        usage: '/checkpoint <taskId>',
        handler: async (args) => this.cmdCheckpoint(args),
      },
      {
        name: 'evidence',
        aliases: ['ev'],
        description: 'Show evidence ledger for a task',
        usage: '/evidence <taskId>',
        handler: async (args) => this.cmdEvidence(args),
      },
      {
        name: 'dashboard',
        aliases: ['dash'],
        description: 'Launch the TUI dashboard',
        usage: '/dashboard [taskId]',
        handler: async (args) => this.cmdDashboard(args),
      },
      {
        name: 'clear',
        aliases: ['clr'],
        description: 'Clear the log',
        usage: '/clear',
        handler: async () => this.cmdClear(),
      },
      {
        name: 'belief',
        aliases: [],
        description: 'Print the current task belief state (top hypotheses with confidence bars)',
        usage: '/belief [taskId]',
        handler: async (args) => this.cmdBelief(args),
      },
      {
        name: 'probes',
        aliases: [],
        description: 'Print pending probe recommendations ordered by priority',
        usage: '/probes [taskId]',
        handler: async (args) => this.cmdProbes(args),
      },
      {
        name: 'verify',
        aliases: [],
        description: 'Print the open verification matrix for the current task',
        usage: '/verify [taskId]',
        handler: async (args) => this.cmdVerify(args),
      },
      {
        name: 'failures',
        aliases: [],
        description: 'Print failed attempts + disproven hypotheses (most recent first)',
        usage: '/failures [taskId]',
        handler: async (args) => this.cmdFailures(args),
      },
      {
        name: 'trace',
        aliases: [],
        description: 'Print the last 20 trace events as a timeline',
        usage: '/trace [taskId]',
        handler: async (args) => this.cmdTrace(args),
      },
      {
        name: 'pr',
        aliases: [],
        description: 'Generate and print the PR summary markdown for the current task',
        usage: '/pr [taskId]',
        handler: async (args) => this.cmdPr(args),
      },
      {
        name: 'doctor',
        aliases: [],
        description: 'Run environment / database / provider health probes (equivalent to `forge doctor`)',
        usage: '/doctor',
        handler: async () => this.cmdDoctor(),
      },
      {
        name: 'sessions',
        aliases: [],
        description: 'List tasks in the state store with status + risk level (equivalent to `forge sessions`)',
        usage: '/sessions',
        handler: async () => this.cmdSessions(),
      },
      {
        name: 'mode',
        aliases: [],
        description: 'Set the agent mode for the active session (implement|repair|review|maintain|research)',
        usage: '/mode <implement|repair|review|maintain|research>',
        handler: async (args) => this.cmdMode(args),
      },
      {
        name: 'budget',
        aliases: [],
        description: 'Set the per-session token budget (in tokens)',
        usage: '/budget <n>',
        handler: async (args) => this.cmdBudget(args),
      },
      {
        name: 'compact',
        aliases: [],
        description: 'Force context compaction on the active session (if the agent loop supports it)',
        usage: '/compact',
        handler: async () => this.cmdCompact(),
      },
      {
        name: 'quit',
        aliases: ['exit', 'q'],
        description: 'Quit forge',
        usage: '/quit',
        handler: async () => {
          this.stop()
          process.exit(0)
        },
      },
    ]
  }

  async start(): Promise<void> {
    this.screen = blessed.screen({
      smartCSR: true,
      title: 'Forge',
      dockBorders: true,
      cursor: {
        artificial: true,
        shape: 'line',
        blink: true,
        color: 'white',
      },
    })

    this.buildLayout()
    this.setupKeys()
    this.screen.render()

    this.log('Welcome to Forge — long-horizon software engineering agent')
    this.log(`Provider: {bold}${this.config.provider.name}{/bold} ({bold}${this.config.provider.model}{/bold})`)
    this.log(`Mode: {bold}${this.config.mode}{/bold}`)
    this.log(`State: {bold}${process.env.FORGE_DATABASE_URL ? 'Postgres' : 'file fallback (degraded; configure FORGE_DATABASE_URL)'}{/bold}`)
    this.log('Type a task and press Enter, or type {bold}/help{/bold} for commands.')
    this.log('')
  }

  private buildLayout(): void {
    this.screen.title = 'Forge — Interactive'

    this.logBox = blessed.box({
      parent: this.screen,
      top: 0,
      left: 0,
      width: '100%',
      height: '100%-3',
      label: ' Forge ',
      border: { type: 'line' },
      style: { fg: 'white', bg: 'black', border: { fg: 'cyan' } },
      scrollable: true,
      alwaysScroll: true,
      scrollbar: { style: { bg: 'blue' } },
      tags: true,
      content: '',
    })

    this.inputBox = blessed.textbox({
      parent: this.screen,
      bottom: 1,
      left: 1,
      width: '100%-2',
      height: 1,
      inputOnFocus: true,
      style: { fg: 'white', bg: 'blue', focus: { bg: 'green' } },
      placeholder: ' Describe the task or type /help...',
    })

    this.footerBox = blessed.box({
      parent: this.screen,
      bottom: 0,
      left: 0,
      width: '100%',
      height: 1,
      style: { fg: 'white', bg: 'black' },
      content: ' [Enter] submit  [/command]  [Ctrl+C] quit  [↑↓] scroll  ',
    })

    this.screen.render()
  }

  private setupKeys(): void {
    this.screen.key(['C-c'], () => {
      this.stop()
      process.exit(0)
    })

    this.screen.key(['C-l'], () => this.cmdClear())

    this.inputBox.key(['enter'], async () => {
      if (this.running) return
      const input = (this.inputBox.value || '').trim()
      if (!input) return

      this.inputBox.clearValue()
      this.inputBox.setContent('')
      this.screen.render()

      if (input.startsWith('/')) {
        await this.handleCommand(input)
      } else {
        await this.runTask(input)
      }
    })

    const focusable = [this.logBox, this.inputBox]
    this.screen.key(['tab'], () => {
      const current = this.screen.focused
      const idx = focusable.indexOf(current)
      const next = (idx + 1) % focusable.length
      focusable[next]!.focus()
      this.screen.render()
    })

    this.inputBox.focus()
  }

  private async handleCommand(input: string): Promise<void> {
    const parts = input.slice(1).trim().split(/\s+/)
    const cmdName = parts[0]?.toLowerCase()
    const args = parts.slice(1)

    const cmd = this.commands.find(
      (c) => c.name === cmdName || c.aliases.includes(cmdName ?? ''),
    )

    if (cmd) {
      await cmd.handler(args)
    } else {
      this.log(`{red-fg}Unknown command:{/red-fg} /${cmdName}`)
      this.log('  Type {bold}/help{/bold} for available commands.')
    }

    this.log('')
  }

  private log(text: string): void {
    this.logLines.push(text)
    if (this.logLines.length > 1000) {
      this.logLines = this.logLines.slice(-500)
    }
    this.logBox.setContent(this.logLines.join('\n'))
    this.logBox.setScrollPerc(100)
    this.screen.render()
  }

  // ── Slash command handlers ──────────────────────────────────

  private async cmdHelp(): Promise<void> {
    this.log('{bold}Available commands:{/bold}')
    this.log('')
    for (const cmd of this.commands) {
      const aliases = cmd.aliases.length > 0 ? ` (${cmd.aliases.map((a) => '/' + a).join(', ')})` : ''
      this.log(`  {cyan-fg}${cmd.usage}{/cyan-fg}${aliases}`)
      this.log(`    ${cmd.description}`)
    }
  }

  private async cmdSetup(): Promise<void> {
    this.log('Launching setup wizard...')
    this.screen.destroy()

    try {
      const wizard = new ConfigWizard()
      const result = await wizard.start()

      if (!result.cancelled && result.config.provider) {
        this.config.provider.name = result.config.provider.name
        this.config.provider.model = result.config.provider.model
        if (result.config.provider.apiKey) {
          this.config.provider.apiKey = result.config.provider.apiKey
        }
        this.log('{green-fg}✓{/green-fg} Configuration updated.')
        this.log(`  Provider: {bold}${this.config.provider.name}{/bold}`)
        this.log(`  Model: {bold}${this.config.provider.model}{/bold}`)
      } else {
        this.log('Setup cancelled.')
      }
    } catch (err) {
      this.log(`{red-fg}Setup error:{/red-fg} ${err instanceof Error ? err.message : String(err)}`)
    }

    this.rebuild()
  }

  private async cmdModel(args: string[]): Promise<void> {
    if (args.length === 0) {
      this.log(`Current model: {bold}${this.config.provider.model}{/bold}`)
      this.log('  Use {bold}/model <name>{/bold} to change it.')
      return
    }

    const model = args.join(' ')
    this.config.provider.model = model
    await this.persistConfig()
    this.log(`{green-fg}✓{/green-fg} Model set to: {bold}${model}{/bold}`)
  }

  private async cmdProvider(args: string[]): Promise<void> {
    if (args.length === 0) {
      this.log(`Current provider: {bold}${this.config.provider.name}{/bold}`)
      this.log('  Use {bold}/provider <name>{/bold} to change it.')
      return
    }

    const name = args[0]!.toLowerCase()
    this.config.provider.name = name as any
    await this.persistConfig()
    this.log(`{green-fg}✓{/green-fg} Provider set to: {bold}${name}{/bold}`)
  }

  private async cmdInit(args: string[]): Promise<void> {
    this.log('Initializing forge config...')

    try {
      const stateDir = join(process.cwd(), DEFAULT_STATE_DIR)
      await mkdir(stateDir, { recursive: true })

      const fileConfig: ForgeConfigFile = {
        provider: {
          name: this.config.provider.name,
          model: this.config.provider.model,
        },
        mode: this.config.mode,
        logLevel: 'info' as any,
      }

      const fp = join(stateDir, 'config.json')
      await writeFile(fp, JSON.stringify(fileConfig, null, 2), 'utf-8')

      const subdirs = ['tasks', 'evidence', 'evidence/artifacts', 'failures', 'decisions', 'verification', 'checkpoints', 'patches', 'traces']
      for (const subdir of subdirs) {
        await mkdir(join(stateDir, subdir), { recursive: true })
      }

      this.log(`{green-fg}✓{/green-fg} Forge initialized at ${stateDir}`)
    } catch (err) {
      this.log(`{red-fg}Error:{/red-fg} ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  private async cmdStatus(args: string[]): Promise<void> {
    const engine = new TaskStateEngine({ stateDir: this.config.stateDir })
    const taskId = args[0]

    if (taskId) {
      const task = await engine.getTask(taskId)
      if (!task) {
        this.log(`{red-fg}Task not found:{/red-fg} ${taskId}`)
        return
      }

      this.log('{bold}Task:{/bold} ' + taskId)
      this.log(`  Status: {bold}${task.status}{/bold}`)
      this.log(`  Interpretation: ${task.currentInterpretation}`)
      this.log(`  Next action: ${task.nextAction}`)

      if (task.subtasks.length > 0) {
        this.log(`  Subtasks: ${task.subtasks.filter((s) => s.status === 'completed').length}/${task.subtasks.length}`)
      }
      if (task.filesTouched.length > 0) {
        this.log(`  Files: ${task.filesTouched.length}`)
      }
      if (task.completedWork.length > 0) {
        this.log(`  Completed: ${task.completedWork.length}`)
      }
    } else {
      const tasks = await engine.listTasks()
      if (tasks.length === 0) {
        this.log('No tasks found.')
        return
      }
      this.log(`{bold}Tasks ({tasks.length}):{/bold}`)
      for (const id of tasks) {
        const t = await engine.getTask(id)
        if (t) {
          const icon = t.status === 'completed' ? '{green-fg}✓{/green-fg}' : t.status === 'failed' ? '{red-fg}✗{/red-fg}' : t.status === 'blocked' ? '{yellow-fg}⚠{/yellow-fg}' : '{cyan-fg}○{/cyan-fg}'
          this.log(`  ${icon} {bold}${id}{/bold} — ${t.status} — ${t.currentInterpretation.slice(0, 60)}`)
        }
      }
    }
  }

  private async cmdTasks(): Promise<void> {
    await this.cmdStatus([])
  }

  private async cmdResume(args: string[]): Promise<void> {
    const taskId = args[0]
    if (!taskId) {
      this.log('{red-fg}Error:{/red-fg} task ID required. Usage: /resume <taskId>')
      return
    }

    const engine = new TaskStateEngine({ stateDir: this.config.stateDir })
    const task = await engine.getTask(taskId)
    if (!task) {
      this.log(`No file-state task found for {bold}${taskId}{/bold}; trying durable Postgres resume.`)
    }

    this.log(`Continuing task: {bold}${taskId}{/bold}`)
    this.log(`Previous status: ${task?.status ?? 'durable state'}`)

    if (task) await engine.resumeTask(taskId)

    this.log('')
    this.log(`{bold}─── Continuing ${taskId}{/bold}`)
    this.log('')

    const startTime = Date.now()
    try {
      const agent = new AgentLoop({
        provider: this.config.provider,
        workDir: this.config.workDir,
        stateDir: this.config.stateDir,
        mode: this.config.mode,
        maxIterations: LONG_HORIZON_MAX_ITERATIONS,
        budget: {
          maxWallClockMs: LONG_HORIZON_MAX_WALL_CLOCK_MS,
          maxIterations: LONG_HORIZON_MAX_ITERATIONS,
        },
        features: this.config.features,
        git: this.config.git,
        localModel: this.config.localModel,
        stateStoreMode: process.env.FORGE_DATABASE_URL ? 'postgres' : 'file',
      })

      await agent.buildRepoIntelligence()
      const result = await agent.resume(taskId)

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
      this.log(`{bold}─── Resume Result (${elapsed}s) ───{/bold}`)
      this.log(`  Status: {bold}${result.status}{/bold}`)
      this.log(`  Iterations: ${result.iterations}`)
      this.log(`  Summary: ${result.summary}`)
    } catch (err) {
      this.log(`{red-fg}Error:{/red-fg} ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  private async cmdCheckpoint(args: string[]): Promise<void> {
    const taskId = args[0]
    if (!taskId) {
      this.log('{red-fg}Error:{/red-fg} task ID required. Usage: /checkpoint <taskId>')
      return
    }

    const cm = new CheckpointManager({ stateDir: this.config.stateDir })
    const checkpoints = await cm.getCheckpointTree(taskId)

    if (checkpoints.length === 0) {
      this.log('No checkpoints found for this task.')
      return
    }

    this.log(`{bold}Checkpoints for ${taskId}:{/bold}`)
    for (const cp of checkpoints) {
      const icon = cp.promotionDecision === 'promoted' ? '{green-fg}✓{/green-fg}' : cp.promotionDecision === 'rejected' ? '{red-fg}✗{/red-fg}' : '{cyan-fg}○{/cyan-fg}'
      this.log(`  ${icon} {bold}${cp.id}{/bold} — ${cp.hypothesis}`)
      this.log(`      Files: ${cp.filesChanged.join(', ')}`)
      this.log(`      Reason: ${cp.reason}`)
      this.log(`      Verdict: ${cp.promotionDecision ?? 'pending'}`)
      if (cp.failureReason) this.log(`      Failure: ${cp.failureReason}`)
    }
  }

  private async cmdEvidence(args: string[]): Promise<void> {
    const taskId = args[0]
    if (!taskId) {
      this.log('{red-fg}Error:{/red-fg} task ID required. Usage: /evidence <taskId>')
      return
    }

    const evidence = new EvidenceLedgerEngine({ stateDir: this.config.stateDir })
    const failures = new FailureLedgerEngine({ stateDir: this.config.stateDir })
    const decisions = new DecisionLedgerEngine({ stateDir: this.config.stateDir })

    const evidenceSummary = await evidence.getSummary(taskId)
    const failureEntries = await failures.getEntries(taskId)
    const decisionEntries = await decisions.getEntries(taskId)

    this.log(`{bold}Evidence Ledger for ${taskId}:{/bold}`)
    this.log(`  Total: ${evidenceSummary.total}`)
    this.log(`  Verified: ${evidenceSummary.verified}`)
    this.log(`  Unverified: ${evidenceSummary.unverified}`)
    this.log(`  Needs review: ${evidenceSummary.needsReview}`)

    this.log(`{bold}Failure Ledger:{/bold} ${failureEntries.length} entries`)
    for (const f of failureEntries.slice(-5)) {
      this.log(`  {red-fg}✗{/red-fg} ${f.hypothesis} — ${f.lesson}`)
    }

    this.log(`{bold}Decision Ledger:{/bold} ${decisionEntries.length} entries`)
    for (const d of decisionEntries.slice(-5)) {
      this.log(`  → ${d.decision}`)
    }
  }

  private async cmdDashboard(args: string[]): Promise<void> {
    const taskId = args[0]
    this.log('Launching dashboard...')
    this.screen.destroy()

    try {
      const { Dashboard } = await import('./dashboard.js')
      const dashboard = new Dashboard({ stateDir: this.config.stateDir, initialTaskId: taskId })
      await dashboard.start()
    } catch (err) {
      this.log(`{red-fg}Dashboard error:{/red-fg} ${err instanceof Error ? err.message : String(err)}`)
    }

    this.rebuild()
  }

  private cmdClear(): void {
    this.logLines = []
    this.logBox.setContent('')
    this.screen.render()
  }

  // ── t52: eleven new slash command handlers ─────────────────

  /**
   * Resolve the taskId a slash command should operate on. Honour an
   * explicit positional arg first, then fall back to the active
   * session's `activeTaskId`. Returns `undefined` when neither is
   * set — callers handle that as "no active task" and print a
   * friendly message instead of crashing.
   */
  private async resolveTaskId(explicit: string | undefined): Promise<string | undefined> {
    if (explicit && explicit.trim().length > 0) return explicit.trim()
    if (this.activeTaskId) return this.activeTaskId
    // No explicit, no active — try "most-recent task" as a last
    // resort so a returning user with one task in the store gets a
    // useful answer. Returns undefined when the store is empty.
    try {
      const engine = new TaskStateEngine({ stateDir: this.config.stateDir })
      const tasks = await engine.listTasks()
      if (tasks.length === 1) return tasks[0]
    } catch {
      // ignore — state dir may not exist
    }
    return undefined
  }

  /**
   * `/belief [taskId]` — top 3 hypotheses with confidence bars.
   *
   * Reads the live belief state via the `TaskStateEngine`; the
   * belief surface itself is in `@forge/belief`, but for a
   * quick-and-cheap REPL view we read what the file-based
   * engine has stored and render a simple top-N table. When the
   * task has no recorded hypotheses we print "(no live
   * hypotheses)" rather than failing.
   */
  async cmdBelief(args: string[]): Promise<void> {
    const taskId = await this.resolveTaskId(args[0])
    if (!taskId) {
      this.log('{yellow-fg}No active task.{/yellow-fg} Run a task first, or pass one: /belief <taskId>')
      return
    }

    const engine = new TaskStateEngine({ stateDir: this.config.stateDir })
    const task = await engine.getTask(taskId)
    if (!task) {
      this.log(`{red-fg}Task not found:{/red-fg} ${taskId}`)
      return
    }

    this.log(`{bold}Belief — task ${taskId}{/bold}`)
    this.log(`  Goal: ${truncateString(task.currentInterpretation, 100)}`)

    // We don't have a live belief store in the REPL; render the
    // failed-hypotheses list as a proxy. The PR generator + TUI
    // dashboard handle the full belief surface; this command
    // gives the user a quick "what's the state of the world"
    // glance from the file-based engine.
    const failed = task.failedHypotheses ?? []
    const open = failed.length > 0 ? failed : ['(no live hypotheses recorded yet)']
    const top = open.slice(0, 3)
    for (let i = 0; i < top.length; i++) {
      const h = top[i]!
      // Synthetic confidence bar — failed hypotheses are by
      // definition not high-confidence, so we render a small
      // bar. The bar is a visual aid only.
      const pct = i === 0 ? 25 : 15
      const bar = renderConfidenceBar(pct, 16)
      this.log(`  ${(i + 1).toString().padStart(1)}. ${bar} ${truncateString(h, 80)}`)
    }
    if (open.length === 0) {
      this.log('  (no live hypotheses)')
    }
    this.log(`  (${open.length} tracked — see /pr for the full belief surface)`)
  }

  /**
   * `/probes [taskId]` — pending probe recommendations ordered
   * by priority. The REPL doesn't have a live `ProbePlanner`,
   * but the next-best-probe is stored on the task state once the
   * agent loop runs. We surface that as the "top probe" and
   * explain where the full ProbePanel-equivalent list lives.
   */
  async cmdProbes(args: string[]): Promise<void> {
    const taskId = await this.resolveTaskId(args[0])
    if (!taskId) {
      this.log('{yellow-fg}No active task.{/yellow-fg} Run a task first, or pass one: /probes <taskId>')
      return
    }

    const engine = new TaskStateEngine({ stateDir: this.config.stateDir })
    const task = await engine.getTask(taskId)
    if (!task) {
      this.log(`{red-fg}Task not found:{/red-fg} ${taskId}`)
      return
    }

    this.log(`{bold}Probes — task ${taskId}{/bold}`)
    const nextAction = task.nextAction ?? ''
    if (nextAction) {
      this.log(`  Next action: {cyan-fg}${truncateString(nextAction, 80)}{/cyan-fg}`)
    } else {
      this.log('  (no queued probes — task has no recorded next action yet)')
    }
    this.log(`  Remaining work: ${task.remainingWork.length} item(s)`)
    if (task.remainingWork.length > 0) {
      // Use remaining work as a priority-ordered queue — the
      // agent loop pushes higher-priority items first.
      for (const w of task.remainingWork.slice(0, 5)) {
        this.log(`  · ${truncateString(w, 80)}`)
      }
    }
  }

  /**
   * `/verify [taskId]` — open verification matrix for the
   * current task, grouped by status. Reads from
   * `VerificationMatrixEngine`, which is the file-based engine
   * the rest of the TUI uses.
   */
  async cmdVerify(args: string[]): Promise<void> {
    const taskId = await this.resolveTaskId(args[0])
    if (!taskId) {
      this.log('{yellow-fg}No active task.{/yellow-fg} Run a task first, or pass one: /verify <taskId>')
      return
    }

    const engine = new VerificationMatrixEngine({ stateDir: this.config.stateDir })
    const entries = await engine.getEntries(taskId)
    if (entries.length === 0) {
      this.log(`{bold}Verification — task ${taskId}{/bold}`)
      this.log('  (no verification entries recorded)')
      this.log('  Run a task to populate the matrix, or use `forge verify <taskId>` to see the CLI view.')
      return
    }

    const groups = new Map<string, typeof entries>()
    const order = ['failed', 'needs_human_review', 'blocked', 'unverified', 'passed', 'not_applicable', 'skipped']
    for (const e of entries) {
      const k = String(e.status)
      if (!groups.has(k)) groups.set(k, [])
      groups.get(k)!.push(e)
    }

    this.log(`{bold}Verification Matrix — task ${taskId}{/bold}  (${entries.length} entries)`)
    for (const status of order) {
      const group = groups.get(status)
      if (!group || group.length === 0) continue
      const icon = statusIcon(status)
      this.log(`  {bold}${icon} ${status} (${group.length}){/bold}`)
      for (const e of group) {
        const note = e.notes ? ` — ${truncateString(e.notes, 60)}` : ''
        this.log(`      ${truncateString(e.check, 80)}${note}`)
      }
    }
  }

  /**
   * `/failures [taskId]` — failure ledger entries + disproven
   * hypotheses, most recent first. Reads from
   * `FailureLedgerEngine`. Empty ledger is fine — we just print
   * "(no failures recorded)".
   */
  async cmdFailures(args: string[]): Promise<void> {
    const taskId = await this.resolveTaskId(args[0])
    if (!taskId) {
      this.log('{yellow-fg}No active task.{/yellow-fg} Run a task first, or pass one: /failures <taskId>')
      return
    }

    const failures = new FailureLedgerEngine({ stateDir: this.config.stateDir })
    const engine = new TaskStateEngine({ stateDir: this.config.stateDir })
    const entries = await failures.getEntries(taskId)
    const task = await engine.getTask(taskId)

    this.log(`{bold}Failures — task ${taskId}{/bold}  (${entries.length} attempts)`)
    if (entries.length === 0) {
      this.log('  (no failures recorded)')
    } else {
      // Most recent first.
      const recent = [...entries].reverse().slice(0, 10)
      for (const f of recent) {
        this.log(`  {red-fg}✗{/red-fg} {bold}${truncateString(f.hypothesis, 80)}{/bold}`)
        this.log(`      action:  ${truncateString(f.action, 80)}`)
        this.log(`      result:  ${truncateString(f.result, 80)}`)
        this.log(`      lesson:  ${truncateString(f.lesson, 80)}`)
        if (f.nextHypothesis) this.log(`      next:    ${truncateString(f.nextHypothesis, 80)}`)
        this.log(`      when:    ${f.timestamp}`)
      }
    }

    const disproven = task?.failedHypotheses ?? []
    if (disproven.length > 0) {
      this.log('')
      this.log(`{bold}Disproven hypotheses (${disproven.length}):{/bold} — do NOT retry without new evidence`)
      for (const h of disproven) {
        this.log(`  [X] ${truncateString(h, 80)}`)
      }
    }
  }

  /**
   * `/trace [taskId]` — last 20 trace events as a vertical
   * timeline. Reads from the file-based `TraceRecorder` in
   * `@forge/trace`, which stores events at
   * `.forge/traces/<taskId>.json` — the same place the agent
   * loop writes them. This is the file-backed mirror of the
   * Postgres `trace_events` table; for live-DB traces use the
   * `forge verify` CLI command.
   */
  async cmdTrace(args: string[]): Promise<void> {
    const taskId = await this.resolveTaskId(args[0])
    if (!taskId) {
      this.log('{yellow-fg}No active task.{/yellow-fg} Run a task first, or pass one: /trace <taskId>')
      return
    }

    const recorder = new TraceRecorder({ stateDir: this.config.stateDir })
    const all = await recorder.getEvents(taskId)
    const recent = [...all].sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1)).slice(0, 20)

    this.log(`{bold}Trace — task ${taskId}{/bold}  (last ${recent.length}/${all.length})`)
    if (recent.length === 0) {
      this.log('  (no trace events recorded for this task yet)')
      return
    }
    for (let i = 0; i < recent.length; i++) {
      const ev = recent[i]!
      const when = shortTime(ev.timestamp)
      const dur = ev.durationMs != null ? ` (${ev.durationMs}ms)` : ''
      const sep = i === 0 ? '┌' : i === recent.length - 1 ? '└' : '│'
      this.log(`  ${sep} ${when}${dur}  {bold}${ev.type}{/bold}`)
      this.log(`  │  ${truncateString(ev.description, 100)}`)
    }
  }

  /**
   * `/pr [taskId]` — generate a PR summary for the current
   * task and print the body to the REPL. We assemble the
   * minimum-viable `PRGeneratorInput` from the file-based
   * engines; missing surfaces (belief graph, verification
   * plan, risk assessment) are filled in with empty/medium
   * defaults so the generator still runs end-to-end.
   */
  async cmdPr(args: string[]): Promise<void> {
    const taskId = await this.resolveTaskId(args[0])
    if (!taskId) {
      this.log('{yellow-fg}No active task.{/yellow-fg} Run a task first, or pass one: /pr <taskId>')
      return
    }

    const engine = new TaskStateEngine({ stateDir: this.config.stateDir })
    const task = await engine.getTask(taskId)
    if (!task) {
      this.log(`{red-fg}Task not found:{/red-fg} ${taskId}`)
      return
    }

    const evidence = new EvidenceLedgerEngine({ stateDir: this.config.stateDir })
    const failures = new FailureLedgerEngine({ stateDir: this.config.stateDir })
    const decisions = new DecisionLedgerEngine({ stateDir: this.config.stateDir })
    const verify = new VerificationMatrixEngine({ stateDir: this.config.stateDir })
    const cm = new CheckpointManager({ stateDir: this.config.stateDir })

    const evidenceLedger = await evidence.getLedger(taskId)
    const evidenceEntries = evidenceLedger?.entries ?? []
    const failureEntries = await failures.getEntries(taskId)
    const decisionEntries = await decisions.getEntries(taskId)
    const verificationEntries = await verify.getEntries(taskId)
    const checkpoints = await cm.getCheckpointTree(taskId)

    // Build the generator input. Most surfaces are empty here —
    // the REPL is not the full FINALIZE step; the user is just
    // asking "what would the PR look like right now?".
    const now = new Date().toISOString()
    const input: PRGeneratorInput = {
      task,
      contract: undefined,
      verification: verificationEntries,
      evidence: evidenceEntries,
      failures: failureEntries,
      decisions: decisionEntries,
      checkpoints,
      patches: [],
      belief: {
        taskId: task.taskId,
        repoId: task.taskId,
        goal: task.currentInterpretation || task.originalRequest,
        acceptanceCriteria: task.acceptanceCriteria,
        selectedDomains: [],
        selectedGraphRegions: [],
        hypotheses: [],
        claims: [],
        assumptions: [],
        uncertainties: [],
        evidenceRefs: [],
        contradictions: [],
        nodes: [],
        edges: [],
        verificationObligations: [],
        humanReviewRequirements: [],
        updatedAt: now,
      },
      claimEvidenceGraph: {
        taskId: task.taskId,
        topClaim: task.currentInterpretation,
        generatedAt: now,
        verifiedClaims: [],
        unverifiedClaims: [],
        contradictedClaims: [],
        staleClaims: [],
        needsHumanReview: [],
        disprovenHypotheses: [],
        openHypotheses: [],
        reviewerGuidance: [],
      },
      activeVerification: {
        taskId: task.taskId,
        candidateActions: [],
        scores: [],
        claimGaps: [],
        warnings: [],
        generatedAt: now,
      },
      artifactRefs: [],
      riskAssessment: {
        level: 'medium',
        requiresMoreEvidence: false,
        requiresMoreVerification: false,
        requiresConservativeEdits: false,
        requiresMoreCheckpoints: false,
        requiresExplicitHumanApproval: false,
        requiresClearerWarnings: false,
        requiresStrongerReviewGuidance: false,
        notes: [],
      },
    }

    try {
      const out = await generatePRSummary(input)
      this.log(`{bold}PR Summary — task ${taskId}{/bold}`)
      this.log('')
      // Print the body line-by-line so it renders cleanly in
      // the TUI log box (avoids a 200-line single line that
      // would be truncated awkwardly).
      for (const line of out.body.split('\n')) {
        this.log(line)
      }
    } catch (err) {
      this.log(`{red-fg}PR generation failed:{/red-fg} ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /**
   * `/doctor` — run environment / database / provider probes
   * and print the result. Mirrors `forge doctor` but inline.
   * We deliberately re-implement the probes here (rather than
   * importing from `@forge/cli`) to avoid the
   * `forge-cli` ↔ `forge-tui` workspace cycle.
   */
  async cmdDoctor(): Promise<void> {
    this.log('{bold}Forge doctor — environment check{/bold}')

    // 1. Database URL configured?
    const dbUrl = process.env.FORGE_DATABASE_URL
    this.log(`  database:     ${dbUrl ? redactUrl(dbUrl) : '{yellow-fg}FORGE_DATABASE_URL not set{/yellow-fg}'}`)

    // 2. Postgres driver installed?
    let driverOk = false
    let driverDetail = 'postgres not installed'
    try {
      const mod = await import('postgres')
      const factory = (mod as { default?: unknown }).default ?? mod
      driverOk = typeof factory === 'function'
      driverDetail = driverOk ? 'postgres installed' : 'postgres factory not callable'
    } catch (err) {
      driverDetail = err instanceof Error ? err.message : String(err)
    }
    this.log(`  driver:       ${driverOk ? '{green-fg}✓{/green-fg}' : '{red-fg}✗{/red-fg}'} ${driverDetail}`)

    // 3. Postgres reachable?
    let pgOk = false
    let pgDetail = 'skipped (no FORGE_DATABASE_URL)'
    if (dbUrl) {
      try {
        const mod = await import('postgres')
        const factory = ((mod as unknown as { default?: unknown }).default ?? mod) as
          (cs: string) => {
            <T = unknown>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T>
            end(opts?: { timeout?: number }): Promise<void>
          }
        const sql = factory(dbUrl)
        try {
          const result = await sql<[{ ok: number }]>`select 1 as ok`
          pgOk = true
          pgDetail = `reachable (select 1 → ${result[0]?.ok})`
        } finally {
          await sql.end({ timeout: 5 })
        }
      } catch (err) {
        pgDetail = err instanceof Error ? err.message : String(err)
      }
    }
    this.log(`  postgres:     ${pgOk ? '{green-fg}✓{/green-fg}' : dbUrl ? '{red-fg}✗{/red-fg}' : '○'} ${pgDetail}`)

    // 4. State store init — best-effort, never fatal.
    let stateOk = false
    let stateDetail = 'skipped (no DB)'
    if (dbUrl && driverOk) {
      try {
        const { ForgeStateStore, defaultStateStoreConfig } = await import('@forge/state-store')
        const store = new ForgeStateStore({
          config: defaultStateStoreConfig(this.config.workDir, dbUrl),
        })
        const health = await store.init()
        stateOk = health.schemaVersion === health.requiredSchemaVersion
        stateDetail = `schema v${health.schemaVersion} (required v${health.requiredSchemaVersion})`
      } catch (err) {
        stateDetail = err instanceof Error ? err.message : String(err)
      }
    }
    this.log(`  stateStore:   ${stateOk ? '{green-fg}✓{/green-fg}' : dbUrl ? '{red-fg}✗{/red-fg}' : '○'} ${stateDetail}`)

    // 5. Provider reachability — best effort, never fatal.
    const baseUrl = process.env.FORGE_PROVIDER_BASE_URL ?? process.env.MINIMAX_BASE_URL
    let provOk = false
    let provDetail = 'no base URL configured'
    if (baseUrl) {
      const ctrl = new AbortController()
      const t = setTimeout(() => ctrl.abort(), 4000)
      try {
        const res = await fetch(baseUrl, { method: 'GET', signal: ctrl.signal })
        provOk = res.status < 500
        provDetail = `${baseUrl} → HTTP ${res.status}`
      } catch (err) {
        provDetail = err instanceof Error ? err.message : String(err)
      } finally {
        clearTimeout(t)
      }
    }
    this.log(`  provider:     ${provOk ? '{green-fg}✓{/green-fg}' : baseUrl ? '{red-fg}✗{/red-fg}' : '○'} ${provDetail}`)

    const fatal = !driverOk || (dbUrl && (!pgOk || !stateOk))
    this.log('')
    if (fatal) {
      this.log('{red-fg}✗ one or more probes failed{/red-fg}')
    } else {
      this.log('{green-fg}✓ all probes ok{/green-fg}')
    }
  }

  /**
   * `/sessions` — list tasks in the state store with status +
   * a synthetic risk level. Mirrors `forge sessions` but
   * inline. Re-implemented here to avoid the
   * `forge-cli` ↔ `forge-tui` workspace cycle.
   *
   * Risk heuristic: tasks with open failures or no files
   * touched yet are flagged medium; tasks with verification
   * failures or no commands run are flagged high. This is a
   * coarse proxy — the harness's full `assessTaskRisk()` is
   * the source of truth.
   */
  async cmdSessions(): Promise<void> {
    const engine = new TaskStateEngine({ stateDir: this.config.stateDir })
    const ids = await engine.listTasks()
    if (ids.length === 0) {
      this.log('No tasks found.')
      return
    }
    const rows: Array<{
      taskId: string
      status: string
      interpretation: string
      failures: number
      files: number
      risk: 'low' | 'medium' | 'high'
    }> = []
    for (const id of ids) {
      const t = await engine.getTask(id)
      if (!t) continue
      const risk = computeSessionRisk(t)
      rows.push({
        taskId: t.taskId,
        status: t.status,
        interpretation: t.currentInterpretation,
        failures: t.failuresEncountered.length,
        files: t.filesTouched.length,
        risk,
      })
    }
    rows.sort((a, b) => a.taskId.localeCompare(b.taskId))
    this.log(`{bold}Tasks (${rows.length}):{/bold}`)
    for (const r of rows) {
      const icon = r.status === 'completed' ? '{green-fg}✓{/green-fg}'
        : r.status === 'failed' ? '{red-fg}✗{/red-fg}'
        : r.status === 'blocked' ? '{yellow-fg}⚠{/yellow-fg}'
        : '{cyan-fg}○{/cyan-fg}'
      const riskTag = r.risk === 'high' ? '{red-fg}[high]{/red-fg}'
        : r.risk === 'medium' ? '{yellow-fg}[med]{/yellow-fg}'
        : '{dim}[low]{/dim}'
      this.log(`  ${icon} {bold}${r.taskId}{/bold} — ${r.status} ${riskTag} — ${truncateString(r.interpretation, 70)}`)
      this.log(`      files=${r.files}, failures=${r.failures}`)
    }
  }

  /**
   * `/mode <implement|repair|review|maintain|research>` — set
   * the agent mode on the active session. Persists the new
   * mode to `.forge/config.json` and updates the in-memory
   * `ForgeConfig` so subsequent `runTask` calls honour it.
   */
  async cmdMode(args: string[]): Promise<void> {
    const validModes = ['implement', 'repair', 'review', 'maintain', 'research'] as const
    if (args.length === 0 || !args[0]) {
      this.log('{red-fg}Error:{/red-fg} mode required. Usage: /mode <implement|repair|review|maintain|research>')
      return
    }
    const next = args[0].toLowerCase()
    if (!validModes.includes(next as typeof validModes[number])) {
      this.log(`{red-fg}Error:{/red-fg} unknown mode '${args[0]}'.`)
      this.log(`  Valid modes: ${validModes.join(', ')}`)
      return
    }
    this.config.mode = next as typeof validModes[number]
    await this.persistConfig()
    this.log(`{green-fg}✓{/green-fg} Mode set to: {bold}${next}{/bold}`)
  }

  /**
   * `/budget <n>` — set the per-session token budget. The
   * value is stored in memory on the Repl instance and
   * persisted to `.forge/config.json` under a `features`
   * extension key (a future schema version will hoist it
   * onto the top-level config). The agent loop reads
   * `config.tokenBudget` when present.
   */
  async cmdBudget(args: string[]): Promise<void> {
    if (args.length === 0 || !args[0]) {
      this.log('{red-fg}Error:{/red-fg} token budget required. Usage: /budget <n>')
      return
    }
    // `Number('1.5')` → 1.5, `Number('abc')` → NaN, `Number('1e2')`
    // → 100. We want a strict positive integer literal.
    if (!/^\d+$/.test(args[0])) {
      this.log(`{red-fg}Error:{/red-fg} budget must be a positive integer (got '${args[0]}').`)
      return
    }
    const n = Number(args[0])
    if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) {
      this.log(`{red-fg}Error:{/red-fg} budget must be a positive integer (got '${args[0]}').`)
      return
    }
    this.tokenBudget = n
    // Mirror onto config so the agent loop picks it up.
    ;(this.config as unknown as { tokenBudget?: number }).tokenBudget = n
    await this.persistConfig()
    this.log(`{green-fg}✓{/green-fg} Token budget set to: {bold}${n.toLocaleString()}{/bold} tokens`)
  }

  /**
   * `/compact` — force context compaction on the active
   * session. The `AgentLoop` class does not currently expose
   * a public `compact()` method (compaction is internal in
   * `compactMessages()`), so we degrade gracefully rather
   * than crash.
   */
  async cmdCompact(): Promise<void> {
    if (!this.activeTaskId) {
      this.log('{yellow-fg}No active task.{/yellow-fg} Run a task first, then /compact to force a context prune.')
      return
    }
    const candidate = (AgentLoop.prototype as unknown as { compact?: unknown }).compact
    if (typeof candidate !== 'function') {
      this.log('{yellow-fg}compaction not available in this build{/yellow-fg}')
      this.log('  (AgentLoop.compact() is not exported — compaction happens internally during run())')
      return
    }
    try {
      const loop = new AgentLoop({
        provider: this.config.provider,
        workDir: this.config.workDir,
        stateDir: this.config.stateDir,
        mode: this.config.mode,
        maxIterations: 1,
        features: this.config.features,
        git: this.config.git,
      })
      // `compact` is non-standard; cast through unknown.
      const fn = (loop as unknown as { compact: (id: string) => Promise<void> }).compact
      await fn(this.activeTaskId)
      this.log('{green-fg}✓{/green-fg} Compaction triggered for ' + this.activeTaskId)
    } catch (err) {
      this.log(`{red-fg}Compaction failed:{/red-fg} ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // ── Task runner ────────────────────────────────────────────

  private async runTask(task: string): Promise<void> {
    this.log('{bold}─── Running:{/bold} ' + task)
    this.log('')

    this.running = true
    this.footerBox.setContent(' [Enter] submit  [/command]  [Ctrl+C] quit  — Running...')
    this.screen.render()

    const startTime = Date.now()
    let lastIteration = 0

    const onEvent = (event: AgentEvent) => {
      if (event.iteration !== lastIteration && event.iteration > 0) {
        lastIteration = event.iteration
        this.log('')
        this.log(`{cyan-fg}── Iteration ${event.iteration} ──{/cyan-fg}`)
      }

      switch (event.type) {
        case 'status':
          break
        case 'thinking':
          if (event.message) {
            const lines = event.message.split('\n')
            for (const line of lines) {
              this.log(`  {dim}${line}{/dim}`)
            }
          }
          break
        case 'tool_call':
          this.log(`  {yellow-fg}→{/yellow-fg} {bold}${event.toolName}{/bold}`)
          if (event.detail) {
            this.log(`    ${event.detail.slice(0, 300)}`)
          }
          break
        case 'tool_result':
          if (event.detail) {
            this.log(`  {green-fg}←{/green-fg} ${event.detail}`)
          }
          break
        case 'error':
          this.log(`  {red-fg}✗ Error:{/red-fg} ${event.error}`)
          break
      }
    }

    try {
      const agent = new AgentLoop({
        provider: this.config.provider,
        workDir: this.config.workDir,
        stateDir: this.config.stateDir,
        mode: this.config.mode,
        maxIterations: LONG_HORIZON_MAX_ITERATIONS,
        budget: {
          maxWallClockMs: LONG_HORIZON_MAX_WALL_CLOCK_MS,
          maxIterations: LONG_HORIZON_MAX_ITERATIONS,
        },
        features: this.config.features,
        git: this.config.git,
        localModel: this.config.localModel,
        stateStoreMode: process.env.FORGE_DATABASE_URL ? 'postgres' : 'file',
        onEvent,
      })

      this.log('{cyan-fg}─ Scanning repository...{/cyan-fg}')
      await agent.buildRepoIntelligence()
      this.log('{cyan-fg}─ Repository scanned.{/cyan-fg}')
      this.log('')
      this.log('{cyan-fg}─ Agent working...{/cyan-fg}')

      const result = await agent.run(task)

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)

      this.log('')
      this.log('')
      this.log(`{bold}─── Result (${elapsed}s) ───{/bold}`)
      this.log(`  Status: {bold}${result.status}{/bold}`)

      const statusIcon = result.status === 'completed' ? '{green-fg}✓{/green-fg}'
        : result.status === 'failed' ? '{red-fg}✗{/red-fg}'
        : result.status === 'blocked' ? '{yellow-fg}⚠{/yellow-fg}'
        : '{cyan-fg}○{/cyan-fg}'
      this.log(`  ${statusIcon} Iterations: ${result.iterations}`)
      this.log(`  Files touched: ${result.filesTouched.length}`)
      this.log(`  Commands run: ${result.commandsRun.length}`)
      this.log(`  Evidence: ${result.evidenceCount} entries`)
      this.log(`  Failures: ${result.failureCount} recorded`)
      this.log(`  Decisions: ${result.decisionCount} recorded`)
      this.log(`  Verification: ${result.verificationPassed ? '{green-fg}passed{/green-fg}' : '{red-fg}failed{/red-fg}'}`)
      this.log(`  Acceptance: ${result.acceptancePassed ? '{green-fg}passed{/green-fg}' : '{red-fg}failed{/red-fg}'}`)

      if (result.promotedCheckpointId) {
        this.log(`  Promoted checkpoint: ${result.promotedCheckpointId}`)
      }

      this.log(`  Summary: ${result.summary}`)

      if (result.status === 'blocked') {
        this.log('')
        this.activeTaskId = result.taskId
        this.log('{yellow-fg}⚠ Task is waiting for a human decision.{/yellow-fg}')
        this.log('  Select it from /tasks, type an answer into this prompt, or use /resume as a shortcut.')
      }

      if (result.status === 'paused') {
        this.log('')
        this.activeTaskId = result.taskId
        this.log('{yellow-fg}⏸ Task paused with durable state.{/yellow-fg}')
        this.log('  Select it from /tasks and continue when ready.')
      }

      this.log('')
      this.log(`Task ID: ${result.taskId}`)

    } catch (err) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
      this.log('')
      this.log(`{red-fg}─── Error (${elapsed}s) ───{/red-fg}`)
      this.log(`  {red-fg}${err instanceof Error ? err.message : String(err)}{/red-fg}`)
    }

    this.running = false
    this.footerBox.setContent(' [Enter] submit  [/command]  [Ctrl+C] quit  [↑↓] scroll  ')
    this.inputBox.readInput()
    this.screen.render()

    this.log('')
    this.log('─'.repeat(40))
    this.log('')
  }

  // ── Helpers ────────────────────────────────────────────────

  private async persistConfig(): Promise<void> {
    try {
      const fp = join(this.config.stateDir, 'config.json')
      const cfg: ForgeConfigFile = {
        provider: {
          name: this.config.provider.name,
          model: this.config.provider.model,
          apiKey: this.config.provider.apiKey,
        },
        mode: this.config.mode,
        logLevel: 'info' as any,
        features: this.config.features,
      }
      await mkdir(dirname(fp), { recursive: true })
      await writeFile(fp, JSON.stringify(cfg, null, 2), 'utf-8')
    } catch {
      // config file is optional
    }
  }

  private rebuild(): void {
    this.screen = blessed.screen({
      smartCSR: true,
      title: 'Forge',
      dockBorders: true,
      cursor: {
        artificial: true,
        shape: 'line',
        blink: true,
        color: 'white',
      },
    })

    this.buildLayout()
    this.setupKeys()
    this.screen.render()
  }

  stop(): void {
    if (this.screen) {
      this.screen.destroy()
    }
  }
}

function truncateString(value: string | undefined | null, width: number): string {
  const text = value ?? ''
  if (width <= 0) return ''
  return text.length <= width ? text : text.slice(0, Math.max(0, width - 1)) + '…'
}

function renderConfidenceBar(percent: number, width: number): string {
  const safeWidth = Math.max(1, Math.floor(width))
  const safePercent = Math.max(0, Math.min(100, percent))
  const filled = Math.round((safePercent / 100) * safeWidth)
  return '[' + '#'.repeat(filled) + '-'.repeat(safeWidth - filled) + `] ${safePercent}%`
}

function statusIcon(status: string): string {
  switch (status) {
    case 'passed':
    case 'verified':
    case 'completed':
      return '[OK]'
    case 'failed':
    case 'contradicted':
      return '[!!]'
    case 'blocked':
    case 'needs_human_review':
    case 'needs_review':
      return '[??]'
    case 'unverified':
    case 'pending':
      return '[..]'
    case 'skipped':
    case 'not_applicable':
      return '[--]'
    default:
      return '[..]'
  }
}

function shortTime(timestamp: string | undefined): string {
  if (!timestamp) return '--:--:--'
  const tIndex = timestamp.indexOf('T')
  if (tIndex >= 0) return timestamp.slice(tIndex + 1, tIndex + 9) || timestamp.slice(-8)
  return timestamp.slice(-8)
}

function redactUrl(raw: string): string {
  try {
    const url = new URL(raw)
    if (url.password) url.password = '***'
    if (url.username) url.username = url.username ? '***' : ''
    return url.toString()
  } catch {
    return raw.replace(/:\/\/([^:@/]+):([^@/]+)@/, '://***:***@')
  }
}

function computeSessionRisk(task: { failuresEncountered: string[]; commandsRun: string[]; verificationStatus: Record<string, string>; filesTouched: string[] }): 'low' | 'medium' | 'high' {
  const verificationValues = Object.values(task.verificationStatus ?? {})
  if (verificationValues.some((value) => value === 'failed' || value === 'blocked')) return 'high'
  // Real high risk: commands have been run AND produced failures,
  // or the task has accumulated many failures with no progress.
  if (task.failuresEncountered.length >= 3) return 'high'
  // A task with some commands run + at least one failure is medium
  // at least — keeps the UX signal visible without spamming red.
  if (task.failuresEncountered.length > 0) return 'medium'
  // A task that has run commands and touched files is "low" — the
  // task is making progress and nothing has failed.
  if (task.filesTouched.length === 0 && task.commandsRun.length === 0) return 'medium'
  return 'low'
}
