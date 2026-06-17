import blessed from 'blessed'
import { TaskStateEngine, AcceptanceContractEngine, EvidenceLedgerEngine, FailureLedgerEngine, DecisionLedgerEngine } from '@forge/state'
import { VerificationMatrixEngine, CheckpointManager } from '@forge/verification'
import type { TaskState } from '@forge/types'

export interface DashboardOptions {
  stateDir: string
  initialTaskId?: string
}

export class Dashboard {
  private screen: any
  private stateDir: string
  private currentTaskId?: string
  private refreshInterval: ReturnType<typeof setInterval> | undefined

  // Panels
  private headerBox!: any
  private taskBox!: any
  private acceptanceBox!: any
  private evidenceBox!: any
  private filesBox!: any
  private footerBox!: any
  private taskListBox!: any

  // Engines
  private taskEngine: TaskStateEngine
  private acceptanceEngine: AcceptanceContractEngine
  private evidenceEngine: EvidenceLedgerEngine
  private failureEngine: FailureLedgerEngine
  private decisionEngine: DecisionLedgerEngine
  private verificationEngine: VerificationMatrixEngine
  private checkpointManager: CheckpointManager

  constructor(options: DashboardOptions) {
    this.stateDir = options.stateDir
    this.currentTaskId = options.initialTaskId

    this.taskEngine = new TaskStateEngine({ stateDir: options.stateDir })
    this.acceptanceEngine = new AcceptanceContractEngine({ stateDir: options.stateDir })
    this.evidenceEngine = new EvidenceLedgerEngine({ stateDir: options.stateDir })
    this.failureEngine = new FailureLedgerEngine({ stateDir: options.stateDir })
    this.decisionEngine = new DecisionLedgerEngine({ stateDir: options.stateDir })
    this.verificationEngine = new VerificationMatrixEngine({ stateDir: options.stateDir })
    this.checkpointManager = new CheckpointManager({ stateDir: options.stateDir })

    this.screen = blessed.screen({
      smartCSR: true,
      title: 'Forge Dashboard',
    })

    this.buildLayout()
    this.setupKeys()
  }

  private buildLayout(): void {
    // ── Header ──────────────────────────────────────
    this.headerBox = blessed.box({
      parent: this.screen,
      top: 0,
      left: 0,
      width: '100%',
      height: 1,
      style: { fg: 'white', bg: 'blue' },
      content: ' ⚒ FORGE  ',
      tags: true,
    })

    // ── Task list (shown when no task selected) ──────
    this.taskListBox = blessed.list({
      parent: this.screen,
      top: 1,
      left: 0,
      width: '100%',
      height: '100%-2',
      label: ' Tasks ',
      border: { type: 'line' },
      style: { fg: 'white', bg: 'black', selected: { fg: 'white', bg: 'blue' }, border: { fg: 'cyan' } },
      keys: true,
      vi: true,
      items: ['Loading tasks...'],
    })

    this.taskListBox.on('select', async (_item: any, idx: number) => {
      const tasks = await this.taskEngine.listTasks()
      const selected = tasks[idx]
      if (selected) {
        this.currentTaskId = selected
        this.showDashboard()
      }
    })

    // ── Task Info Panel ─────────────────────────────
    this.taskBox = blessed.box({
      parent: this.screen,
      top: 1,
      left: 0,
      width: '40%',
      height: '40%',
      label: ' Task ',
      border: { type: 'line' },
      style: { fg: 'white', bg: 'black', border: { fg: 'cyan' } },
      scrollable: true,
      alwaysScroll: true,
      tags: true,
    })

    // ── Acceptance / Verification Panel ─────────────
    this.acceptanceBox = blessed.box({
      parent: this.screen,
      top: 1,
      left: '40%',
      width: '60%',
      height: '40%',
      label: ' Acceptance & Verification ',
      border: { type: 'line' },
      style: { fg: 'white', bg: 'black', border: { fg: 'cyan' } },
      scrollable: true,
      alwaysScroll: true,
      tags: true,
    })

    // ── Evidence / Failures / Decisions Panel ──────
    this.evidenceBox = blessed.box({
      parent: this.screen,
      top: '40%',
      left: 0,
      width: '70%',
      height: '35%',
      label: ' Evidence / Failures / Decisions ',
      border: { type: 'line' },
      style: { fg: 'white', bg: 'black', border: { fg: 'cyan' } },
      scrollable: true,
      alwaysScroll: true,
      tags: true,
    })

    // ── Files / Checkpoints / Cost Panel ──────────
    this.filesBox = blessed.box({
      parent: this.screen,
      top: '40%',
      left: '70%',
      width: '30%',
      height: '35%',
      label: ' Files / Checkpoints ',
      border: { type: 'line' },
      style: { fg: 'white', bg: 'black', border: { fg: 'cyan' } },
      scrollable: true,
      alwaysScroll: true,
      tags: true,
    })

    // ── Footer ──────────────────────────────────────
    this.footerBox = blessed.box({
      parent: this.screen,
      bottom: 0,
      left: 0,
      width: '100%',
      height: 1,
      style: { fg: 'white', bg: 'black' },
      content: ' [Tab] next panel  [↑↓] scroll  [q] quit  [r] refresh  [t] tasks  ',
    })
  }

  private setupKeys(): void {
    this.screen.key(['q', 'C-c'], () => {
      this.stop()
      process.exit(0)
    })

    this.screen.key(['r'], async () => {
      if (this.currentTaskId) {
        await this.refreshDashboard()
      } else {
        await this.refreshTaskList()
      }
      this.screen.render()
    })

    this.screen.key(['t'], async () => {
      this.currentTaskId = undefined
      this.showTaskList()
      await this.refreshTaskList()
      this.screen.render()
    })

    // Tab between panels
    const focusable = ['taskBox', 'acceptanceBox', 'evidenceBox', 'filesBox']
    let focusIdx = 0
    this.screen.key(['tab'], () => {
      if (!this.currentTaskId) return
      const boxes = [this.taskBox, this.acceptanceBox, this.evidenceBox, this.filesBox]
      boxes.forEach((b: any) => { b.style.border = b.style.border ?? {}; b.style.border.fg = 'cyan' })
      focusIdx = (focusIdx + 1) % boxes.length
      const box = boxes[focusIdx]
      box.style.border = box.style.border ?? {}
      box.style.border.fg = 'yellow'
      box.focus()
      this.screen.render()
    })
  }

  async start(): Promise<void> {
    if (this.currentTaskId) {
      this.showDashboard()
      await this.refreshDashboard()
    } else {
      this.showTaskList()
      await this.refreshTaskList()
    }

    this.screen.render()

    // Auto-refresh every 5s
    this.refreshInterval = setInterval(async () => {
      if (this.currentTaskId) {
        await this.refreshDashboard()
      } else {
        await this.refreshTaskList()
      }
      this.screen.render()
    }, 5000)
  }

  stop(): void {
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval)
    }
    this.screen.destroy()
  }

  private showTaskList(): void {
    this.taskListBox.show()
    this.taskBox.hide()
    this.acceptanceBox.hide()
    this.evidenceBox.hide()
    this.filesBox.hide()
    this.headerBox.setContent(' ⚒ FORGE  —  Select a task ')
  }

  private showDashboard(): void {
    this.taskListBox.hide()
    this.taskBox.show()
    this.acceptanceBox.show()
    this.evidenceBox.show()
    this.filesBox.show()
  }

  private async refreshTaskList(): Promise<void> {
    const tasks = await this.taskEngine.listTasks()
    if (tasks.length === 0) {
      this.taskListBox.setItems(['(no tasks found — run forge run <task>)'])
      return
    }

    const items: string[] = []
    for (const id of tasks) {
      const task = await this.taskEngine.getTask(id)
      if (task) {
        const icon = task.status === 'completed' ? '{green-fg}✓{/green-fg}' : task.status === 'failed' ? '{red-fg}✗{/red-fg}' : task.status === 'blocked' ? '{yellow-fg}⚠{/yellow-fg}' : '{cyan-fg}○{/cyan-fg}'
        const label = task.currentInterpretation.length > 60
          ? task.currentInterpretation.slice(0, 57) + '…'
          : task.currentInterpretation
        items.push(`${icon} {bold}${id}{/bold} — ${task.status} — ${label}`)
      }
    }
    this.taskListBox.setItems(items)
  }

  private async refreshDashboard(): Promise<void> {
    if (!this.currentTaskId) return

    const task = await this.taskEngine.getTask(this.currentTaskId)
    if (!task) {
      this.headerBox.setContent(` ⚒ FORGE  —  Task ${this.currentTaskId} not found `)
      return
    }

    this.renderHeader(task)
    this.renderTaskPanel(task)
    await this.renderAcceptancePanel()
    await this.renderEvidencePanel(task)
    await this.renderFilesPanel(task)
  }

  private renderHeader(task: TaskState): void {
    const statusColor = task.status === 'completed' ? '{green-fg}' : task.status === 'failed' ? '{red-fg}' : task.status === 'blocked' ? '{yellow-fg}' : '{cyan-fg}'
    this.headerBox.setContent(
      ` ⚒ FORGE  ${task.taskId}  ${statusColor}${task.status}{/}  [${task.subtasks.filter((s) => s.status === 'completed').length}/${task.subtasks.length} subtasks]  `,
    )
  }

  private renderTaskPanel(task: TaskState): void {
    const lines: string[] = []

    lines.push(`{bold}Status:{/bold} ${task.status}`)
    lines.push(`{bold}Next:{/bold} ${task.nextAction}`)
    lines.push(`{bold}Created:{/bold} ${task.createdAt.slice(0, 10)}`)

    if (task.subtasks.length > 0) {
      lines.push('')
      lines.push('{bold}Subtasks:{/bold}')
      for (const sub of task.subtasks) {
        const icon = sub.status === 'completed' ? '{green-fg}✓{/green-fg}' : sub.status === 'failed' ? '{red-fg}✗{/red-fg}' : sub.status === 'in_progress' ? '{yellow-fg}→{/yellow-fg}' : '{white-fg}○{/white-fg}'
        lines.push(`  ${icon} {bold}${sub.label}{/bold}`)
        if (sub.status === 'in_progress') lines.push(`    ${sub.description.slice(0, 50)}`)
      }
    }

    if (task.remainingWork.length > 0) {
      lines.push('')
      lines.push('{bold}Remaining:{/bold}')
      for (const rw of task.remainingWork) {
        lines.push(`  · ${rw.slice(0, 60)}`)
      }
    }

    if (task.completedWork.length > 0) {
      lines.push('')
      lines.push('{bold}Completed:{/bold}')
      for (const cw of task.completedWork.slice(-5)) {
        lines.push(`  ✓ ${cw.slice(0, 60)}`)
      }
    }

    this.taskBox.setContent(lines.join('\n'))
  }

  private async renderAcceptancePanel(): Promise<void> {
    if (!this.currentTaskId) return

    const contract = await this.acceptanceEngine.getContract(this.currentTaskId)
    const verification = await this.verificationEngine.getEntries(this.currentTaskId)

    const lines: string[] = []

    if (contract && contract.criteria.length > 0) {
      lines.push('{bold}Acceptance Criteria:{/bold}')
      for (const c of contract.criteria) {
        const icon = c.status === 'verified' ? '{green-fg}✓{/green-fg}' : c.status === 'failed' ? '{red-fg}✗{/red-fg}' : c.status === 'needs_review' ? '{yellow-fg}?{/yellow-fg}' : '{white-fg}○{/white-fg}'
        lines.push(`  ${icon} {bold}${c.id}{/bold} ${c.description.slice(0, 50)}`)
      }
    }

    if (verification.length > 0) {
      lines.push('')
      lines.push('{bold}Verification:{/bold}')
      for (const v of verification) {
        const icon = v.status === 'passed' ? '{green-fg}✓{/green-fg}' : v.status === 'failed' ? '{red-fg}✗{/red-fg}' : v.status === 'needs_human_review' ? '{yellow-fg}?{/yellow-fg}' : '{white-fg}○{/white-fg}'
        lines.push(`  ${icon} {bold}${v.check.slice(0, 40)}{/bold} ${v.status}`)
      }

      const passed = verification.filter((v) => v.status === 'passed').length
      const failed = verification.filter((v) => v.status === 'failed').length
      lines.push('')
      lines.push(`  Passed: ${passed}  Failed: ${failed}  Total: ${verification.length}`)
    }

    this.acceptanceBox.setContent(lines.join('\n') || '(no acceptance criteria or verification)')
  }

  private async renderEvidencePanel(task: TaskState): Promise<void> {
    if (!this.currentTaskId) return

    const evidence = await this.evidenceEngine.getSummary(this.currentTaskId)
    const failures = await this.failureEngine.getEntries(this.currentTaskId)
    const decisions = await this.decisionEngine.getEntries(this.currentTaskId)

    const lines: string[] = []

    lines.push(`{bold}Evidence:{/bold} ${evidence.total} entries (${evidence.verified} verified, ${evidence.unverified} unverified, ${evidence.needsReview} needs review)`)

    const recentEvidence = await this.evidenceEngine.getNeedsReviewClaims(this.currentTaskId)
    for (const e of recentEvidence.slice(0, 3)) {
      lines.push(`  {yellow-fg}?{/yellow-fg} ${e.claim.slice(0, 60)}`)
    }

    lines.push('')
    lines.push(`{bold}Failures:{/bold} ${failures.length} recorded`)
    for (const f of failures.slice(-3)) {
      lines.push(`  {red-fg}✗{/red-fg} {bold}${f.hypothesis.slice(0, 40)}{/bold}`)
      lines.push(`    ${f.lesson.slice(0, 60)}`)
    }

    lines.push('')
    lines.push(`{bold}Decisions:{/bold} ${decisions.length} recorded`)
    for (const d of decisions.slice(-3)) {
      lines.push(`  → {bold}${d.decision.slice(0, 50)}{/bold}`)
    }

    this.evidenceBox.setContent(lines.join('\n'))
  }

  private async renderFilesPanel(task: TaskState): Promise<void> {
    if (!this.currentTaskId) return

    const checkpoints = await this.checkpointManager.getCheckpoints(this.currentTaskId)
    const patches = await this.checkpointManager.getPatches(this.currentTaskId)

    const lines: string[] = []

    lines.push(`{bold}Files touched:{/bold} ${task.filesTouched.length}`)
    for (const f of task.filesTouched.slice(-8)) {
      lines.push(`  · ${f}`)
    }

    lines.push('')
    lines.push(`{bold}Commands run:{/bold} ${task.commandsRun.length}`)
    lines.push(`{bold}Tests run:{/bold} ${task.testsRun.length}`)

    lines.push('')
    lines.push(`{bold}Checkpoints:{/bold} ${checkpoints.length}`)
    const promoted = checkpoints.filter((c) => c.promotionDecision === 'promoted')
    const rejected = checkpoints.filter((c) => c.promotionDecision === 'rejected')
    const active = checkpoints.filter((c) => !c.promotionDecision)
    lines.push(`  {green-fg}Promoted:{/green-fg} ${promoted.length}  {red-fg}Rejected:{/red-fg} ${rejected.length}  {cyan-fg}Active:{/cyan-fg} ${active.length}`)

    if (promoted.length > 0) {
      lines.push(`  Latest: ${promoted[promoted.length - 1]!.hypothesis.slice(0, 50)}`)
    }

    lines.push('')
    const promotedPatches = patches.filter((p) => p.promoted)
    lines.push(`{bold}Patches:{/bold} ${patches.length} (${promotedPatches.length} promoted)`)

    this.filesBox.setContent(lines.join('\n') || '(no files or checkpoints)')
  }
}
