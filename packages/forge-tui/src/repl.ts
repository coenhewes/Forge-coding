import blessed from 'blessed'
import { AgentLoop } from '@forge/agent'
import type { ForgeConfig } from '@forge/types'

export class Repl {
  private screen: any
  private logBox: any
  private inputBox: any
  private footerBox: any
  private running = false
  private logLines: string[] = []
  private config: ForgeConfig

  constructor(config: ForgeConfig) {
    this.config = config
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
    this.log(`Provider: ${this.config.provider.name} (${this.config.provider.model})`)
    this.log(`Mode: ${this.config.mode}`)
    this.log('Type a task below and press Enter to start.')
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
      placeholder: ' Describe the task...',
    })

    this.footerBox = blessed.box({
      parent: this.screen,
      bottom: 0,
      left: 0,
      width: '100%',
      height: 1,
      style: { fg: 'white', bg: 'black' },
      content: ' [Enter] submit  [Ctrl+C] quit  [↑↓] scroll  ',
    })

    this.screen.render()
  }

  private setupKeys(): void {
    this.screen.key(['C-c'], () => {
      this.stop()
      process.exit(0)
    })

    this.screen.key(['C-l'], () => {
      this.logLines = []
      this.logBox.setContent('')
      this.screen.render()
    })

    this.inputBox.key(['enter'], async () => {
      if (this.running) return
      const task = (this.inputBox.value || '').trim()
      if (!task) return

      this.inputBox.clearValue()
      this.inputBox.setContent('')
      this.running = true
      this.footerBox.setContent(' [Enter] submit  [Ctrl+C] quit  [↑↓] scroll  — Running...')
      this.inputBox.cancel()
      this.screen.render()

      await this.runTask(task)

      this.running = false
      this.inputBox.readInput()
      this.footerBox.setContent(' [Enter] submit  [Ctrl+C] quit  [↑↓] scroll  ')
      this.screen.render()
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

  private log(text: string): void {
    this.logLines.push(text)
    if (this.logLines.length > 1000) {
      this.logLines = this.logLines.slice(-500)
    }
    this.logBox.setContent(this.logLines.join('\n'))
    this.logBox.setScrollPerc(100)
    this.screen.render()
  }

  private async runTask(task: string): Promise<void> {
    this.log('{bold}─── Running:{/bold} ' + task)
    this.log('')

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
        this.log('  Use: forge resume <taskId> to continue')
      }

      this.log('')
      this.log(`Task ID: ${result.taskId}`)

    } catch (err) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
      this.log('')
      this.log(`{red-fg}─── Error (${elapsed}s) ───{/red-fg}`)
      this.log(`  {red-fg}${err instanceof Error ? err.message : String(err)}{/red-fg}`)
    }

    this.log('')
    this.log('─'.repeat(40))
    this.log('')
  }

  stop(): void {
    if (this.screen) {
      this.screen.destroy()
    }
  }
}
