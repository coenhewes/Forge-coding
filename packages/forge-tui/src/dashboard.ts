import blessed from 'blessed'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { TaskStateEngine, AcceptanceContractEngine, EvidenceLedgerEngine, FailureLedgerEngine, DecisionLedgerEngine } from '@forge/state'
import { VerificationMatrixEngine, CheckpointManager } from '@forge/verification'
import type {
  TaskState,
  Assumption,
  Uncertainty,
  Contradiction,
  Claim,
  Hypothesis,
  EvidenceRef,
  ProbeRecommendation,
} from '@forge/types'
import {
  BeliefStore,
  InMemoryBeliefStore,
  ProbePlanner,
  generateAssuranceCase,
} from '@forge/belief'
import type {
  StateStoreLike,
  EvidenceEntry as BeliefEvidenceEntry,
  ScoredProbe,
} from '@forge/belief'

export interface DashboardOptions {
  stateDir: string
  initialTaskId?: string
  /**
   * Optional belief-graph state store. When omitted the dashboard
   * falls back to an `InMemoryBeliefStore` so the new belief-graph
   * panels render gracefully (with empty/zero counts) even when no
   * Postgres connection is available. Production callers that wire
   * Forge up to a real `ForgeStateStore` should pass
   * `stateStore.asStateStoreLike()` here so the panels read the same
   * durable data the agent loop writes to.
   */
  stateStore?: StateStoreLike
}

interface PanelBox {
  setContent(content: string): void
  show(): void
  hide(): void
  focus(): void
  setLabel?(label: string): void
  style: { border?: { fg?: string }; selected?: { fg?: string; bg?: string } }
}

/**
 * Dashboard mode. The default `classic` mode shows the four original
 * panels (Task / Acceptance+Verification / Evidence+Failures+Decisions /
 * Files+Checkpoints+PR). The `belief` mode replaces them with the five
 * belief-graph panels required by the Active Repo Belief Graph feature
 * (current belief state, hypothesis board, probe queue, assumption
 * tracker, assurance case). Press `[b]` to toggle.
 */
type DashboardMode = 'classic' | 'belief'

const BELIEF_PANEL_LABELS = {
  belief: ' Current Belief State ',
  hypothesis: ' Hypothesis Board ',
  probe: ' Probe Queue ',
  assumption: ' Assumptions & Contradictions ',
  assurance: ' Assurance Case ',
} as const

const CLASSIC_PANEL_LABELS = {
  task: ' Task ',
  acceptance: ' Acceptance & Verification ',
  evidence: ' Evidence / Failures / Decisions ',
  files: ' Files / Checkpoints / PR ',
} as const

/**
 * Capabilities exposed by the Forge semantic MCP fabric. The probe
 * planner only enumerates a probe for a capability the task can
 * actually invoke, so we pass this list (filtered by the active
 * domain selection) to the planner. The TUI doesn't have the agent's
 * live domain selection, so we default to the full set — same shape
 * the agent loop uses when the router hasn't narrowed yet.
 */
const DEFAULT_CAPABILITIES: string[] = [
  'repo.find_definitions',
  'repo.find_callers',
  'tests.find_related_tests',
  'db.get_table_schema',
  'db.find_migrations_touching_table',
  'auth.trace_permission_check',
  'auth.find_policy_sources',
  'frontend.find_route_component',
  'frontend.find_state_owner',
]

export class Dashboard {
  private screen: any
  private stateDir: string
  private currentTaskId?: string
  private refreshInterval: ReturnType<typeof setInterval> | undefined
  private mode: DashboardMode = 'classic'
  private focusIdx = 0

  // Classic-mode panels
  private headerBox!: PanelBox
  private taskBox!: PanelBox
  private acceptanceBox!: PanelBox
  private evidenceBox!: PanelBox
  private filesBox!: PanelBox
  private footerBox!: PanelBox
  private taskListBox!: any

  // Belief-mode panels (Active Repo Belief Graph)
  private beliefBox!: PanelBox
  private hypothesisBox!: PanelBox
  private probeBox!: PanelBox
  private assumptionBox!: PanelBox
  private assuranceBox!: PanelBox

  // Engines
  private taskEngine: TaskStateEngine
  private acceptanceEngine: AcceptanceContractEngine
  private evidenceEngine: EvidenceLedgerEngine
  private failureEngine: FailureLedgerEngine
  private decisionEngine: DecisionLedgerEngine
  private verificationEngine: VerificationMatrixEngine
  private checkpointManager: CheckpointManager

  // Belief-graph wiring
  private beliefBackend: InMemoryBeliefStore
  private beliefStore: BeliefStore
  private probePlanner: ProbePlanner
  private readonly stateStore: StateStoreLike

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

    // Belief store wiring. Always fall back to an InMemoryBeliefStore
    // when no durable store is provided so the belief panels render
    // (with empty state) rather than throwing. The agent loop and any
    // real Forge deployment passes the live ForgeStateStore here.
    this.beliefBackend = new InMemoryBeliefStore()
    this.stateStore = options.stateStore ?? this.beliefBackend.asStateStoreLike()
    this.beliefStore = new BeliefStore(this.stateStore)
    this.probePlanner = new ProbePlanner()

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
    }) as PanelBox

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

    // ── Classic: Task Info Panel ─────────────────────
    this.taskBox = blessed.box({
      parent: this.screen,
      top: 1,
      left: 0,
      width: '40%',
      height: '40%',
      label: CLASSIC_PANEL_LABELS.task,
      border: { type: 'line' },
      style: { fg: 'white', bg: 'black', border: { fg: 'cyan' } },
      scrollable: true,
      alwaysScroll: true,
      tags: true,
    }) as PanelBox

    // ── Classic: Acceptance / Verification Panel ─────
    this.acceptanceBox = blessed.box({
      parent: this.screen,
      top: 1,
      left: '40%',
      width: '60%',
      height: '40%',
      label: CLASSIC_PANEL_LABELS.acceptance,
      border: { type: 'line' },
      style: { fg: 'white', bg: 'black', border: { fg: 'cyan' } },
      scrollable: true,
      alwaysScroll: true,
      tags: true,
    }) as PanelBox

    // ── Classic: Evidence / Failures / Decisions ────
    this.evidenceBox = blessed.box({
      parent: this.screen,
      top: '40%',
      left: 0,
      width: '70%',
      height: '35%',
      label: CLASSIC_PANEL_LABELS.evidence,
      border: { type: 'line' },
      style: { fg: 'white', bg: 'black', border: { fg: 'cyan' } },
      scrollable: true,
      alwaysScroll: true,
      tags: true,
    }) as PanelBox

    // ── Classic: Files / Checkpoints / Cost Panel ────
    this.filesBox = blessed.box({
      parent: this.screen,
      top: '40%',
      left: '70%',
      width: '30%',
      height: '35%',
      label: CLASSIC_PANEL_LABELS.files,
      border: { type: 'line' },
      style: { fg: 'white', bg: 'black', border: { fg: 'cyan' } },
      scrollable: true,
      alwaysScroll: true,
      tags: true,
    }) as PanelBox

    // ── Belief: Current Belief State (top-left) ─────
    // ── Belief: Hypothesis Board (top-right) ────────
    // ── Belief: Probe Queue (mid-left) ──────────────
    // ── Belief: Assumption & Contradiction (mid-right)
    // ── Belief: Assurance Case (bottom, full width) ─
    this.beliefBox = blessed.box({
      parent: this.screen,
      top: 1,
      left: 0,
      width: '40%',
      height: '40%',
      label: BELIEF_PANEL_LABELS.belief,
      border: { type: 'line' },
      style: { fg: 'white', bg: 'black', border: { fg: 'cyan' } },
      scrollable: true,
      alwaysScroll: true,
      tags: true,
    }) as PanelBox

    this.hypothesisBox = blessed.box({
      parent: this.screen,
      top: 1,
      left: '40%',
      width: '60%',
      height: '40%',
      label: BELIEF_PANEL_LABELS.hypothesis,
      border: { type: 'line' },
      style: { fg: 'white', bg: 'black', border: { fg: 'cyan' } },
      scrollable: true,
      alwaysScroll: true,
      tags: true,
    }) as PanelBox

    this.probeBox = blessed.box({
      parent: this.screen,
      top: '40%',
      left: 0,
      width: '40%',
      height: '25%',
      label: BELIEF_PANEL_LABELS.probe,
      border: { type: 'line' },
      style: { fg: 'white', bg: 'black', border: { fg: 'cyan' } },
      scrollable: true,
      alwaysScroll: true,
      tags: true,
    }) as PanelBox

    this.assumptionBox = blessed.box({
      parent: this.screen,
      top: '40%',
      left: '40%',
      width: '60%',
      height: '25%',
      label: BELIEF_PANEL_LABELS.assumption,
      border: { type: 'line' },
      style: { fg: 'white', bg: 'black', border: { fg: 'cyan' } },
      scrollable: true,
      alwaysScroll: true,
      tags: true,
    }) as PanelBox

    this.assuranceBox = blessed.box({
      parent: this.screen,
      top: '65%',
      left: 0,
      width: '100%',
      height: '34%',
      label: BELIEF_PANEL_LABELS.assurance,
      border: { type: 'line' },
      style: { fg: 'white', bg: 'black', border: { fg: 'cyan' } },
      scrollable: true,
      alwaysScroll: true,
      tags: true,
    }) as PanelBox

    // ── Footer ──────────────────────────────────────
    this.footerBox = blessed.box({
      parent: this.screen,
      bottom: 0,
      left: 0,
      width: '100%',
      height: 1,
      style: { fg: 'white', bg: 'black' },
      content: ' [Tab] next panel  [↑↓] scroll  [q] quit  [r] refresh  [t] tasks  [b] toggle belief mode ',
    }) as PanelBox
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

    // Toggle belief / classic mode.
    this.screen.key(['b'], async () => {
      this.mode = this.mode === 'classic' ? 'belief' : 'classic'
      this.focusIdx = 0
      if (this.currentTaskId) {
        this.showDashboard()
        await this.refreshDashboard()
      } else {
        this.showTaskList()
      }
      this.screen.render()
    })

    // Tab between panels. The cycle depends on the active mode so
    // users land only on panels that are actually visible.
    this.screen.key(['tab'], () => {
      if (!this.currentTaskId) return
      const boxes = this.mode === 'classic'
        ? [this.taskBox, this.acceptanceBox, this.evidenceBox, this.filesBox]
        : [this.beliefBox, this.hypothesisBox, this.probeBox, this.assumptionBox, this.assuranceBox]
      for (const b of boxes) {
        b.style.border = b.style.border ?? {}
        b.style.border.fg = 'cyan'
      }
      this.focusIdx = (this.focusIdx + 1) % boxes.length
      const box = boxes[this.focusIdx]!
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
    for (const box of this.allPanels()) box.hide()
    this.headerBox.setContent(' ⚒ FORGE  —  Select a task ')
  }

  private showDashboard(): void {
    this.taskListBox.hide()
    if (this.mode === 'classic') {
      this.taskBox.show()
      this.acceptanceBox.show()
      this.evidenceBox.show()
      this.filesBox.show()
      for (const box of this.beliefPanels()) box.hide()
    } else {
      for (const box of this.beliefPanels()) box.show()
      for (const box of this.classicPanels()) box.hide()
    }
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

    if (this.mode === 'classic') {
      this.renderTaskPanel(task)
      await this.renderAcceptancePanel()
      await this.renderEvidencePanel(task)
      await this.renderFilesPanel(task)
    } else {
      await this.renderBeliefPanel(task)
      await this.renderHypothesisPanel()
      await this.renderProbeQueuePanel()
      await this.renderAssumptionPanel()
      await this.renderAssurancePanel()
    }
  }

  private renderHeader(task: TaskState): void {
    const statusColor = task.status === 'completed' ? '{green-fg}' : task.status === 'failed' ? '{red-fg}' : task.status === 'blocked' ? '{yellow-fg}' : '{cyan-fg}'
    const modeTag = this.mode === 'belief' ? ' {magenta-fg}[belief]{/magenta-fg}' : ''
    this.headerBox.setContent(
      ` ⚒ FORGE  ${task.taskId}  ${statusColor}${task.status}{/}  [${task.subtasks.filter((s) => s.status === 'completed').length}/${task.subtasks.length} subtasks]${modeTag}  `,
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

    // ── PR readiness ──
    const contract = await this.acceptanceEngine.getContract(this.currentTaskId)
    const verification = await this.verificationEngine.getEntries(this.currentTaskId)
    const failedChecks = verification.filter((v) => v.status === 'failed').length
    const needsReview = verification.filter((v) => v.status === 'needs_human_review').length
    const verifiedCriteria = contract?.criteria.filter((c) => c.status === 'verified').length ?? 0
    const totalCriteria = contract?.criteria.length ?? 0
    const prPath = join(this.stateDir, 'tasks', this.currentTaskId, 'PR.md')
    const prReady = existsSync(prPath)

    lines.push('')
    lines.push('{bold}PR Readiness:{/bold}')
    lines.push(`  ${prReady ? '{green-fg}✓{/green-fg}' : '{white-fg}○{/white-fg}'} PR body ${prReady ? 'generated' : 'not yet'}`)
    lines.push(`  Acceptance: ${verifiedCriteria}/${totalCriteria} verified`)
    const blockers = failedChecks + needsReview + task.reviewBlockers.length
    lines.push(`  ${blockers === 0 ? '{green-fg}' : '{yellow-fg}'}Blockers: ${blockers}{/}`)
    for (const rb of task.reviewBlockers.slice(0, 3)) lines.push(`    · ${rb.slice(0, 50)}`)

    this.filesBox.setContent(lines.join('\n') || '(no files or checkpoints)')
  }

  /* ---------------------------------------------------------------- *
   *  Belief-mode panels — Active Repo Belief Graph
   * ---------------------------------------------------------------- */

  private classicPanels(): PanelBox[] {
    return [this.taskBox, this.acceptanceBox, this.evidenceBox, this.filesBox]
  }

  private beliefPanels(): PanelBox[] {
    return [this.beliefBox, this.hypothesisBox, this.probeBox, this.assumptionBox, this.assuranceBox]
  }

  private allPanels(): PanelBox[] {
    return [...this.classicPanels(), ...this.beliefPanels()]
  }

  /**
   * Render the "Current Belief State" panel: the top hypothesis,
   * its confidence, supporting + contradicting evidence, the open
   * uncertainty that should be resolved next, and the probe the
   * planner currently recommends.
   */
  private async renderBeliefPanel(task: TaskState): Promise<void> {
    if (!this.currentTaskId) return

    const belief = await this.beliefStore.loadTaskBeliefState(this.currentTaskId)
    const top = belief ? pickTopHypothesis(belief.hypotheses) : null
    const probes = await this.planProbesForTask(this.currentTaskId)
    const nextProbe = probes[0]?.probe

    const lines: string[] = []
    lines.push(`{bold}Task:{/bold} ${truncate(task.currentInterpretation, 60)}`)
    lines.push('')

    if (!top) {
      lines.push('{yellow-fg}No belief state yet.{/yellow-fg}')
      lines.push('Run `forge run` to seed hypotheses, claims, and evidence.')
      lines.push('')
      lines.push('{bold}Next best probe:{/bold} —')
      this.beliefBox.setContent(lines.join('\n'))
      return
    }

    lines.push('{bold}Top hypothesis:{/bold}')
    lines.push(`  ${truncate(top.claim, 70)}`)
    lines.push('')
    lines.push(`{bold}Confidence:{/bold} ${formatConfidence(top.confidence)}  {bold}Status:{/bold} ${formatStatus(top.status)}`)

    const support = await this.resolveEvidenceRefs(top.supportingEvidence, this.currentTaskId)
    const contra = await this.resolveEvidenceRefs(top.contradictingEvidence, this.currentTaskId)
    lines.push('')
    lines.push(`{bold}Supporting evidence:{/bold} ${support.length === 0 ? 'none' : ''}`)
    for (const e of support.slice(0, 4)) {
      lines.push(`  {green-fg}✓{/green-fg} ${truncate(e.summary ?? e.id, 60)}`)
    }
    if (support.length > 4) lines.push(`  {gray-fg}…${support.length - 4} more{/gray-fg}`)

    lines.push('')
    lines.push(`{bold}Contradictions:{/bold} ${contra.length === 0 ? 'none' : ''}`)
    for (const e of contra.slice(0, 4)) {
      lines.push(`  {red-fg}✗{/red-fg} ${truncate(e.summary ?? e.id, 60)}`)
    }
    if (contra.length > 4) lines.push(`  {gray-fg}…${contra.length - 4} more{/gray-fg}`)

    // Open uncertainty — prefer uncertainties tagged for the top
    // hypothesis; fall back to the first open one.
    const allUncertainties: Uncertainty[] = belief?.uncertainties ?? []
    const topHypothesisUncertainties = allUncertainties.filter((u) => u.relatedHypotheses.includes(top.id))
    const openUncertainty = topHypothesisUncertainties[0] ?? allUncertainties[0]
    lines.push('')
    lines.push(`{bold}Open uncertainty:{/bold} ${openUncertainty ? truncate(openUncertainty.text, 60) : 'none recorded'}`)

    lines.push('')
    lines.push(`{bold}Next best probe:{/bold} ${nextProbe ? formatProbe(nextProbe) : '—'}`)
    if (nextProbe) lines.push(`  ${truncate(nextProbe.reason, 60)}`)

    this.beliefBox.setContent(lines.join('\n'))
  }

  /**
   * Render the "Hypothesis Board": all hypotheses grouped by status
   * (likely / plausible / weak / disproven) with their confidence
   * scores, exactly as the spec's "Likely / Plausible / Weak /
   * Disproven" four-bucket view.
   */
  private async renderHypothesisPanel(): Promise<void> {
    if (!this.currentTaskId) return

    const belief = await this.beliefStore.loadTaskBeliefState(this.currentTaskId)
    const hypotheses = belief?.hypotheses ?? []
    const buckets = bucketHypotheses(hypotheses)

    const lines: string[] = []
    lines.push(`{bold}Hypotheses:{/bold} ${hypotheses.length}`)

    const sections: Array<{ key: Hypothesis['status']; title: string; color: string; items: Hypothesis[] }> = [
      { key: 'likely', title: 'Likely', color: 'green-fg', items: buckets.likely },
      { key: 'plausible', title: 'Plausible', color: 'cyan-fg', items: buckets.plausible },
      { key: 'unknown', title: 'Weak / Unknown', color: 'yellow-fg', items: [...buckets.weak, ...buckets.unknown] },
      { key: 'contradicted', title: 'Disproven', color: 'red-fg', items: [...buckets.disproven, ...buckets.contradicted] },
    ]

    let totalShown = 0
    for (const section of sections) {
      if (section.items.length === 0) continue
      lines.push('')
      lines.push(`{${section.color}}{bold}${section.title}:{/bold}{/} ${section.items.length}`)
      for (const h of section.items.slice(0, 4)) {
        lines.push(`  ${formatConfidence(h.confidence)} — ${truncate(h.claim, 56)}`)
      }
      if (section.items.length > 4) lines.push(`  {gray-fg}…${section.items.length - 4} more{/gray-fg}`)
      totalShown += section.items.length
    }

    if (totalShown === 0) {
      lines.push('')
      lines.push('{yellow-fg}No hypotheses recorded for this task yet.{/yellow-fg}')
      lines.push('The belief graph will populate after the first probe or')
      lines.push('the agent loop runs `BeliefStore.addHypothesis`.')
    }

    this.hypothesisBox.setContent(lines.join('\n'))
  }

  /**
   * Render the "Probe Queue": the scored candidates the ProbePlanner
   * produced for the live claims and capabilities. Each entry shows
   * the value, cost, and which hypotheses / claims it would
   * distinguish or verify.
   */
  private async renderProbeQueuePanel(): Promise<void> {
    if (!this.currentTaskId) return

    const scored = await this.planProbesForTask(this.currentTaskId)

    const lines: string[] = []
    lines.push(`{bold}Probe queue:{/bold} ${scored.length} candidate${scored.length === 1 ? '' : 's'}`)

    if (scored.length === 0) {
      lines.push('')
      lines.push('{yellow-fg}No probes available.{/yellow-fg}')
      lines.push('(no open claims and no capabilities matched)')
      this.probeBox.setContent(lines.join('\n'))
      return
    }

    const top = scored.slice(0, 6)
    top.forEach((entry, idx) => {
      const p = entry.probe
      const gain = p.expectedInformationGain
      const cost = p.cost
      const score = entry.score.toFixed(2)
      lines.push('')
      lines.push(`{bold}${idx + 1}. ${p.capability}{/bold}  {gray-fg}score=${score}{/gray-fg}`)
      lines.push(`   value: {green-fg}${gain}{/green-fg}  cost: {yellow-fg}${cost}{/yellow-fg}  risk: ${p.risk}`)
      if (p.distinguishesHypotheses.length > 0) {
        lines.push(`   distinguishes: ${p.distinguishesHypotheses.length} hypothesis${p.distinguishesHypotheses.length === 1 ? '' : 'es'}`)
      }
      if (p.verifiesClaims.length > 0) {
        lines.push(`   verifies: ${p.verifiesClaims.length} claim${p.verifiesClaims.length === 1 ? '' : 'es'}`)
      }
      lines.push(`   ${truncate(p.reason, 60)}`)
    })

    if (scored.length > top.length) {
      lines.push('')
      lines.push(`{gray-fg}…${scored.length - top.length} more candidate${scored.length - top.length === 1 ? '' : 's'}{/gray-fg}`)
    }

    this.probeBox.setContent(lines.join('\n'))
  }

  /**
   * Render the "Assumption & Contradiction Tracker": every recorded
   * assumption with its status, supporting evidence count, and the
   * consequence text the agent attached to it; plus any open
   * contradictions that have not yet been resolved.
   */
  private async renderAssumptionPanel(): Promise<void> {
    if (!this.currentTaskId) return

    const belief = await this.beliefStore.loadTaskBeliefState(this.currentTaskId)
    const assumptions: Assumption[] = belief?.assumptions ?? []
    const contradictions: Contradiction[] = belief?.contradictions ?? []

    const lines: string[] = []
    lines.push(`{bold}Assumptions:{/bold} ${assumptions.length}`)

    if (assumptions.length === 0) {
      lines.push('')
      lines.push('{yellow-fg}No assumptions recorded for this task yet.{/yellow-fg}')
      lines.push('The belief graph attaches assumptions to hypotheses when')
      lines.push('the agent loop creates them; this view will populate as')
      lines.push('the harness works through the task.')
    } else {
      for (const a of assumptions.slice(0, 6)) {
        lines.push('')
        lines.push(`{bold}Assumption:{/bold} ${truncate(a.text, 60)}`)
        lines.push(`  status: ${formatAssumptionStatus(a.status)}  evidence: ${a.evidenceRefs.length}`)
        if (a.consequence) {
          lines.push(`  consequence: ${truncate(a.consequence, 60)}`)
        }
      }
      if (assumptions.length > 6) lines.push(`\n{gray-fg}…${assumptions.length - 6} more{/gray-fg}`)
    }

    lines.push('')
    lines.push(`{bold}Contradictions:{/bold} ${contradictions.length}`)
    if (contradictions.length === 0) {
      lines.push('  none recorded')
    } else {
      for (const c of contradictions.slice(0, 4)) {
        lines.push(`  {red-fg}✗{/red-fg} ${truncate(c.reason, 60)}`)
      }
      if (contradictions.length > 4) lines.push(`  {gray-fg}…${contradictions.length - 4} more{/gray-fg}`)
    }

    this.assumptionBox.setContent(lines.join('\n'))
  }

  /**
   * Render the "Assurance Case" panel: the PR-facing claim-evidence
   * tree produced by `generateAssuranceCase`. The panel is the
   * final pre-PR view a reviewer would consult; it shows the top
   * claim, the verified / unverified / contradicted / stale / needs
   * human-review buckets, and the open reviewer guidance the agent
   * thinks the human should look at first.
   */
  private async renderAssurancePanel(): Promise<void> {
    if (!this.currentTaskId) return

    const graph = await generateAssuranceCase(this.stateStore, this.currentTaskId)

    const lines: string[] = []
    lines.push('{bold}Top claim:{/bold}')
    lines.push(`  ${truncate(graph.topClaim, 90)}`)
    lines.push('')
    lines.push(
      `{bold}Summary:{/bold} ` +
        `{green-fg}verified ${graph.verifiedClaims.length}{/green-fg} · ` +
        `{cyan-fg}unverified ${graph.unverifiedClaims.length}{/cyan-fg} · ` +
        `{red-fg}contradicted ${graph.contradictedClaims.length}{/red-fg} · ` +
        `{yellow-fg}stale ${graph.staleClaims.length}{/yellow-fg} · ` +
        `{magenta-fg}needs_human_review ${graph.needsHumanReview.length}{/magenta-fg}`,
    )
    lines.push('')

    lines.push('{bold}Verified:{/bold}')
    if (graph.verifiedClaims.length === 0) {
      lines.push('  (none yet)')
    } else {
      for (const c of graph.verifiedClaims.slice(0, 4)) {
        lines.push(`  {green-fg}✓{/green-fg} ${truncate(c.claim.text, 70)}  ({c.supportingEvidence.length} evidence)`)
      }
      if (graph.verifiedClaims.length > 4) lines.push(`  {gray-fg}…${graph.verifiedClaims.length - 4} more{/gray-fg}`)
    }

    lines.push('')
    lines.push('{bold}Needs human review:{/bold}')
    if (graph.needsHumanReview.length === 0) {
      lines.push('  (none)')
    } else {
      for (const c of graph.needsHumanReview.slice(0, 4)) {
        lines.push(`  {magenta-fg}?{/magenta-fg} ${truncate(c.claim.text, 70)}`)
        if (c.claim.reviewerGuidance) {
          lines.push(`     guidance: ${truncate(c.claim.reviewerGuidance, 60)}`)
        }
      }
      if (graph.needsHumanReview.length > 4) lines.push(`  {gray-fg}…${graph.needsHumanReview.length - 4} more{/gray-fg}`)
    }

    lines.push('')
    lines.push('{bold}Unverified:{/bold} ' + graph.unverifiedClaims.length)
    for (const c of graph.unverifiedClaims.slice(0, 3)) {
      lines.push(`  {cyan-fg}○{/cyan-fg} ${truncate(c.claim.text, 70)}`)
    }
    if (graph.unverifiedClaims.length > 3) lines.push(`  {gray-fg}…${graph.unverifiedClaims.length - 3} more{/gray-fg}`)

    if (graph.contradictedClaims.length > 0) {
      lines.push('')
      lines.push('{bold}Contradicted:{/bold} ' + graph.contradictedClaims.length)
      for (const c of graph.contradictedClaims.slice(0, 3)) {
        lines.push(`  {red-fg}✗{/red-fg} ${truncate(c.claim.text, 70)}`)
      }
    }

    if (graph.staleClaims.length > 0) {
      lines.push('')
      lines.push('{bold}Stale:{/bold} ' + graph.staleClaims.length)
      for (const c of graph.staleClaims.slice(0, 3)) {
        lines.push(`  {yellow-fg}!{/yellow-fg} ${truncate(c.claim.text, 70)}`)
      }
    }

    if (graph.openHypotheses.length > 0 || graph.disprovenHypotheses.length > 0) {
      lines.push('')
      lines.push(
        `{bold}Hypotheses:{/bold} {cyan-fg}open ${graph.openHypotheses.length}{/cyan-fg} · ` +
          `{red-fg}disproven ${graph.disprovenHypotheses.length}{/red-fg}`,
      )
    }

    if (graph.reviewerGuidance.length > 0) {
      lines.push('')
      lines.push('{bold}Reviewer guidance:{/bold}')
      for (const g of graph.reviewerGuidance.slice(0, 4)) {
        lines.push(`  · ${truncate(g, 70)}`)
      }
      if (graph.reviewerGuidance.length > 4) lines.push(`  {gray-fg}…${graph.reviewerGuidance.length - 4} more{/gray-fg}`)
    }

    this.assuranceBox.setContent(lines.join('\n'))
  }

  /* ---------------------------------------------------------------- *
   *  Belief-graph data helpers
   * ---------------------------------------------------------------- */

  /**
   * Pull the live claims and hypotheses for the task and ask the
   * ProbePlanner to score candidate probes against them. The planner
   * filters out probes that previously returned `inconclusive` for a
   * claim, so a TUI reader sees a queue that reflects the harness's
   * actual progress.
   */
  private async planProbesForTask(taskId: string): Promise<ScoredProbe[]> {
    const claims = await this.stateStore.repos.claims.listByTask(taskId)
    const hypotheses = await this.stateStore.repos.hypotheses.listByTask(taskId)

    if (claims.length === 0 && hypotheses.length === 0) return []

    return this.probePlanner.plan({
      taskId,
      claims: claims.map(rowToClaim),
      hypotheses: hypotheses.map(rowToHypothesis),
      capabilities: DEFAULT_CAPABILITIES,
      priorOutcomes: (capability, claimId) => {
        // We don't currently track per-probe outcomes in the file
        // state; fall back to "no prior outcome" so every probe
        // stays in the queue. When the agent loop records probe
        // results, this hook can pull them from the evidence ledger.
        void capability
        void claimId
        return undefined
      },
    })
  }

  /**
   * Resolve a list of evidence refs against the belief store's
   * evidence repo, falling back to the EvidenceRef id + summary if
   * the row is missing (so the panel can still render something).
   */
  private async resolveEvidenceRefs(refs: EvidenceRef[], taskId: string): Promise<BeliefEvidenceEntry[]> {
    const resolved: BeliefEvidenceEntry[] = []
    for (const ref of refs) {
      const row = await this.stateStore.repos.evidence.get(ref.id)
      if (row) {
        resolved.push({
          id: String(row.id),
          summary: typeof row.summary === 'string' ? row.summary : ref.summary,
          artifactRef: typeof row.artifactId === 'string' ? row.artifactId : ref.artifactRef,
          polarity: 'supports',
          createdAt: typeof row.createdAt === 'string' ? row.createdAt : new Date().toISOString(),
        })
      } else if (ref.summary || ref.artifactRef) {
        resolved.push({
          id: ref.id,
          summary: ref.summary,
          artifactRef: ref.artifactRef,
          polarity: 'supports',
          createdAt: new Date(0).toISOString(),
        })
      }
    }
    void taskId
    return resolved
  }
}

/* ---------------------------------------------------------------- *
 *  Pure helpers (no state, easy to test in isolation)
 * ---------------------------------------------------------------- */

/** Pick the top hypothesis: highest-confidence non-disproven/non-superseded. */
export function pickTopHypothesis(hypotheses: Hypothesis[]): Hypothesis | null {
  if (hypotheses.length === 0) return null
  const candidates = hypotheses
    .filter((h) => h.status !== 'disproven' && h.status !== 'superseded')
    .sort((a, b) => b.confidence - a.confidence)
  return candidates[0] ?? null
}

export interface HypothesisBuckets {
  likely: Hypothesis[]
  plausible: Hypothesis[]
  weak: Hypothesis[]
  unknown: Hypothesis[]
  disproven: Hypothesis[]
  contradicted: Hypothesis[]
}

export function bucketHypotheses(hypotheses: Hypothesis[]): HypothesisBuckets {
  const buckets: HypothesisBuckets = {
    likely: [],
    plausible: [],
    weak: [],
    unknown: [],
    disproven: [],
    contradicted: [],
  }
  for (const h of hypotheses) {
    switch (h.status) {
      case 'likely':
        buckets.likely.push(h)
        break
      case 'plausible':
        buckets.plausible.push(h)
        break
      case 'unknown':
        buckets.unknown.push(h)
        break
      case 'verified':
        // A verified hypothesis is the converged end-state for a
        // claim-equivalent hypothesis. The spec's 4-bucket board
        // (Likely / Plausible / Weak / Disproven) doesn't have a
        // verified slot, so we surface verified hypotheses as the
        // "Weak" row only when their confidence is unusually low;
        // otherwise we surface them as "Likely" so reviewers can
        // see the converged state at a glance.
        if (h.confidence < 0.4) buckets.weak.push(h)
        else buckets.likely.push(h)
        break
      case 'needs_human_review':
        // Same handling: treat as Weak so it stands out for human
        // attention rather than blending into the Likely bucket.
        buckets.weak.push(h)
        break
      case 'contradicted':
        buckets.contradicted.push(h)
        break
      case 'disproven':
        buckets.disproven.push(h)
        break
      case 'stale':
      case 'superseded':
        // Stale / superseded hypotheses are not part of the active
        // board; show them under Weak so the reviewer still sees
        // them but knows the harness has moved on.
        buckets.weak.push(h)
        break
    }
  }
  return buckets
}

function formatConfidence(c: number): string {
  return `0.${Math.max(0, Math.min(99, Math.round(c * 100)))
    .toString()
    .padStart(2, '0')} ({bold}${c >= 0.7 ? 'likely' : c >= 0.4 ? 'plausible' : 'weak'}{/bold})`
}

function formatStatus(s: Hypothesis['status']): string {
  const color = s === 'likely' || s === 'verified'
    ? 'green-fg'
    : s === 'contradicted' || s === 'disproven'
      ? 'red-fg'
      : s === 'needs_human_review' || s === 'stale'
        ? 'yellow-fg'
        : 'cyan-fg'
  return `{${color}}${s}{/}`
}

function formatAssumptionStatus(s: Assumption['status']): string {
  switch (s) {
    case 'verified': return '{green-fg}verified{/green-fg}'
    case 'contradicted': return '{red-fg}contradicted{/red-fg}'
    case 'stale': return '{yellow-fg}stale{/yellow-fg}'
    case 'unverified': return '{cyan-fg}unverified{/cyan-fg}'
  }
}

function formatProbe(p: ProbeRecommendation): string {
  return `${p.capability}  {gray-fg}(value=${p.expectedInformationGain}, cost=${p.cost}){/gray-fg}`
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return s.slice(0, Math.max(0, max - 1)) + '…'
}

/** Convert a raw `claims` repo row into a typed `Claim` (assurance.ts uses the same shape). */
export function rowToClaim(row: {
  id: string
  text: string
  status: string
  confidence: number | null
  riskLevel: string | null
  acceptanceCriterionId: string | null
  reviewerGuidance: string | null
}): Claim {
  return {
    id: row.id,
    text: row.text,
    status: row.status as Claim['status'],
    confidence: row.confidence ?? 0,
    riskLevel: (row.riskLevel ?? 'low') as Claim['riskLevel'],
    acceptanceCriterionRefs: row.acceptanceCriterionId ? [row.acceptanceCriterionId] : [],
    supportingEvidence: [],
    contradictingEvidence: [],
    missingEvidence: [],
    verificationChecks: [],
    reviewerGuidance: row.reviewerGuidance ?? undefined,
  }
}

/** Convert a raw `hypotheses` repo row into a typed `Hypothesis`. */
export function rowToHypothesis(row: {
  id: string
  claim: string
  status: string
  confidence: number
  relevantDomains: string[]
  relevantGraphNodes: string[]
  createdAt: string
  updatedAt: string
}): Hypothesis {
  return {
    id: row.id,
    claim: row.claim,
    status: row.status as Hypothesis['status'],
    confidence: row.confidence,
    relevantDomains: row.relevantDomains,
    relevantGraphNodes: row.relevantGraphNodes,
    supportingEvidence: [],
    contradictingEvidence: [],
    assumptions: [],
    suggestedProbes: [],
    suggestedPatchStrategies: [],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}
// `Uncertainty` and `Contradiction` are surfaced through the belief
// store's `loadTaskBeliefState` view (see the belief panel for
// uncertainty rows and the assumption panel for contradiction rows).
// They're rendered as plain rows today; the typed imports are kept
// so future panel extensions can attach richer rendering without
// re-wiring the type chain.
