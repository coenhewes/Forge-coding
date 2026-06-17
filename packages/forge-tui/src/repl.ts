import blessed from 'blessed'
import { AgentLoop } from '@forge/agent'
import { TaskStateEngine, EvidenceLedgerEngine, FailureLedgerEngine, DecisionLedgerEngine } from '@forge/state'
import { VerificationMatrixEngine, CheckpointManager } from '@forge/verification'
import { ConfigWizard } from './config-wizard.js'
import { writeFile, mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import type { ForgeConfig, ForgeConfigFile } from '@forge/types'

const DEFAULT_STATE_DIR = '.forge'

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
      this.log(`{red-fg}Task not found:{/red-fg} ${taskId}`)
      return
    }

    this.log(`Resuming task: {bold}${taskId}{/bold}`)
    this.log(`Previous status: ${task.status}`)

    await engine.resumeTask(taskId)

    this.log('')
    this.log(`{bold}─── Running: /resume ${taskId}{/bold}`)
    this.log('')

    const startTime = Date.now()
    try {
      const agent = new AgentLoop({
        provider: this.config.provider,
        workDir: this.config.workDir,
        stateDir: this.config.stateDir,
        mode: this.config.mode,
        maxIterations: 50,
        features: this.config.features,
      })

      await agent.buildRepoIntelligence()
      const result = await agent.run(task.originalRequest)

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

  // ── Task runner ────────────────────────────────────────────

  private async runTask(task: string): Promise<void> {
    this.log('{bold}─── Running:{/bold} ' + task)
    this.log('')

    this.running = true
    this.footerBox.setContent(' [Enter] submit  [/command]  [Ctrl+C] quit  — Running...')
    this.screen.render()

    const startTime = Date.now()

    try {
      this.log('[1/5] Scanning repository...')
      this.screen.render()

      const agent = new AgentLoop({
        provider: this.config.provider,
        workDir: this.config.workDir,
        stateDir: this.config.stateDir,
        mode: this.config.mode,
        maxIterations: 50,
        features: this.config.features,
      })

      await agent.buildRepoIntelligence()
      this.log('[1/5] {green-fg}✓{/green-fg} Repository scanned')

      this.log('[2/5] Routing task to domains...')
      this.log('[3/5] Creating acceptance contract...')
      this.log('[4/5] Selecting affected tests...')
      this.log('[5/5] Entering agent loop...')
      this.log('')

      const result = await agent.run(task)

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)

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
        this.log('{yellow-fg}⚠ Task is blocked waiting for input.{/yellow-fg}')
        this.log('  Use: /resume ' + result.taskId + ' to continue')
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
