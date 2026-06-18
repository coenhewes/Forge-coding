/**
 * PanelsDashboard — 3×4 grid host that wires 12 read-only panels together.
 *
 * Layout (3 columns × 4 rows = 12 panels):
 *
 *   ┌──────────────┬──────────────┬──────────────┐
 *   │   Task       │   Belief     │   Verify     │   row 1
 *   ├──────────────┼──────────────┼──────────────┤
 *   │   Evidence   │   Trace      │   Failures   │   row 2
 *   ├──────────────┼──────────────┼──────────────┤
 *   │   Probe      │ Contradiction│  Decision    │   row 3
 *   ├──────────────┼──────────────┼──────────────┤
 *   │   Checkpoint │   PR Ready   │   Cost       │   row 4
 *   └──────────────┴──────────────┴──────────────┘
 *
 * The first 6 panels were the t50a set. The bottom 6 panels are t51's set
 * (Probe / Contradiction / Decision / Checkpoint / PR Readiness / Cost).
 *
 * Aspect-ratio behaviour:
 *   - height >= 24  → 3-col × 4-row layout (default).
 *   - height <  24  → graceful degradation to a 2-row × 6-col compact
 *                     layout (rows 3+4 are stacked beside rows 1+2 to keep
 *                     every panel visible in short terminals).
 *
 * This host is intentionally headless-friendly: it builds the layout with
 * blessed when available but each panel exposes `render(width, height) -> string`
 * so tests (and headless CI) can drive the same code path without a TTY.
 *
 * Kept separate from the legacy `dashboard.ts` so that file can keep evolving
 * for the in-iteration TUI without churning the panel grid.
 */

import blessed from 'blessed'

import { TaskPanel, type TaskPanelFixture } from './panels/TaskPanel.js'
import { BeliefPanel, type BeliefPanelFixture } from './panels/BeliefPanel.js'
import { VerificationPanel, type VerificationPanelFixture } from './panels/VerificationPanel.js'
import { EvidencePanel, type EvidencePanelFixture } from './panels/EvidencePanel.js'
import { TracePanel, type TracePanelFixture } from './panels/TracePanel.js'
import { FailurePanel, type FailurePanelFixture } from './panels/FailurePanel.js'
import { ProbePanel, type ProbePanelFixture } from './panels/ProbePanel.js'
import { ContradictionPanel, type ContradictionPanelFixture } from './panels/ContradictionPanel.js'
import { DecisionPanel, type DecisionPanelFixture } from './panels/DecisionPanel.js'
import { CheckpointPanel, type CheckpointPanelFixture } from './panels/CheckpointPanel.js'
import { PrReadinessPanel, type PrReadinessPanelFixture } from './panels/PrReadinessPanel.js'
import { CostPanel, type CostPanelFixture } from './panels/CostPanel.js'

export interface PanelsDashboardFixtures {
  task: TaskPanelFixture
  belief: BeliefPanelFixture
  verification: VerificationPanelFixture
  evidence: EvidencePanelFixture
  trace: TracePanelFixture
  failures: FailurePanelFixture
  probe: ProbePanelFixture
  contradiction: ContradictionPanelFixture
  decision: DecisionPanelFixture
  checkpoint: CheckpointPanelFixture
  prReadiness: PrReadinessPanelFixture
  cost: CostPanelFixture
}

export interface PanelsDashboardOptions {
  fixtures: PanelsDashboardFixtures
  /** If true (default), instantiate blessed widgets. Pass false for headless tests. */
  useBlessed?: boolean
  /** Optional title for the host screen. */
  title?: string
}

const ROW_PANELS: ReadonlyArray<readonly [string, string, string]> = [
  ['task', 'belief', 'verification'],
  ['evidence', 'trace', 'failure'],
  ['probe', 'contradiction', 'decision'],
  ['checkpoint', 'prReadiness', 'cost'],
] as const

/** Below this height the dashboard flips to the 2×6 compact layout. */
const COMPACT_HEIGHT_THRESHOLD = 24

/**
 * The dashboard host. Holds all 12 panels, manages the blessed grid, and exposes
 * `renderAll(width, height)` + `renderRow(rowIndex, width, height)` for headless
 * callers and snapshot tests.
 */
export class PanelsDashboard {
  readonly taskPanel: TaskPanel
  readonly beliefPanel: BeliefPanel
  readonly verificationPanel: VerificationPanel
  readonly evidencePanel: EvidencePanel
  readonly tracePanel: TracePanel
  readonly failurePanel: FailurePanel
  readonly probePanel: ProbePanel
  readonly contradictionPanel: ContradictionPanel
  readonly decisionPanel: DecisionPanel
  readonly checkpointPanel: CheckpointPanel
  readonly prReadinessPanel: PrReadinessPanel
  readonly costPanel: CostPanel

  private screen: any | undefined
  private boxes: Record<string, any> = {}
  private useBlessed: boolean

  constructor(options: PanelsDashboardOptions) {
    this.useBlessed = options.useBlessed ?? true

    this.taskPanel = new TaskPanel(options.fixtures.task)
    this.beliefPanel = new BeliefPanel(options.fixtures.belief)
    this.verificationPanel = new VerificationPanel(options.fixtures.verification)
    this.evidencePanel = new EvidencePanel(options.fixtures.evidence)
    this.tracePanel = new TracePanel(options.fixtures.trace)
    this.failurePanel = new FailurePanel(options.fixtures.failures)
    this.probePanel = new ProbePanel(options.fixtures.probe)
    this.contradictionPanel = new ContradictionPanel(options.fixtures.contradiction)
    this.decisionPanel = new DecisionPanel(options.fixtures.decision)
    this.checkpointPanel = new CheckpointPanel(options.fixtures.checkpoint)
    this.prReadinessPanel = new PrReadinessPanel(options.fixtures.prReadiness)
    this.costPanel = new CostPanel(options.fixtures.cost)

    if (this.useBlessed) this.initBlessed(options.title ?? 'Forge')
  }

  /** Update all fixtures + refresh blessed boxes (if mounted). */
  update(fixtures: PanelsDashboardFixtures): void {
    this.taskPanel.setFixture(fixtures.task)
    this.beliefPanel.setFixture(fixtures.belief)
    this.verificationPanel.setFixture(fixtures.verification)
    this.evidencePanel.setFixture(fixtures.evidence)
    this.tracePanel.setFixture(fixtures.trace)
    this.failurePanel.setFixture(fixtures.failures)
    this.probePanel.setFixture(fixtures.probe)
    this.contradictionPanel.setFixture(fixtures.contradiction)
    this.decisionPanel.setFixture(fixtures.decision)
    this.checkpointPanel.setFixture(fixtures.checkpoint)
    this.prReadinessPanel.setFixture(fixtures.prReadiness)
    this.costPanel.setFixture(fixtures.cost)
    this.refresh()
  }

  /** Look up a panel by its row/col position (0-indexed). */
  panelAt(row: 0 | 1 | 2 | 3, col: 0 | 1 | 2): TaskPanel | BeliefPanel | VerificationPanel
    | EvidencePanel | TracePanel | FailurePanel | ProbePanel | ContradictionPanel
    | DecisionPanel | CheckpointPanel | PrReadinessPanel | CostPanel {
    const key = `${ROW_PANELS[row]?.[col] ?? 'task'}Panel`
    return (this as any)[key]
  }

  /**
   * Render one row of 3 panels as a single string. Useful for snapshot tests
   * that want to assert on a single row's content without the full dashboard.
   */
  renderRow(rowIndex: 0 | 1 | 2 | 3, width: number, height: number): string {
    const safeRow: 0 | 1 | 2 | 3 = ((rowIndex as number) | 0) as 0 | 1 | 2 | 3
    if (safeRow < 0 || safeRow > 3) {
      throw new Error(`renderRow: rowIndex out of range (got ${rowIndex}, expected 0..3)`)
    }
    const w = Math.max(20, Math.floor(width))
    const colW = Math.max(20, Math.floor(w / 3))
    const a = this.panelAt(safeRow, 0).render(colW, height)
    const b = this.panelAt(safeRow, 1).render(colW, height)
    const c = this.panelAt(safeRow, 2).render(colW, height)
    return joinRow(a, b, c, colW)
  }

  /**
   * Headless render — returns all 12 panels joined into one text block.
   *
   * Aspect ratio:
   *   - height >= 24  → 3-col × 4-row layout
   *   - height <  24  → 2-row × 6-col compact fallback (graceful degradation)
   */
  renderAll(width = 80, height = 24): string {
    if (height < COMPACT_HEIGHT_THRESHOLD) {
      return this.renderAllCompact(width, height)
    }
    const w = Math.max(60, Math.floor(width))
    const rowH = Math.max(5, Math.floor(height / 4))
    return [
      this.renderRow(0, w, rowH),
      this.renderRow(1, w, rowH),
      this.renderRow(2, w, rowH),
      this.renderRow(3, w, rowH),
    ].join('\n')
  }

  /**
   * Compact 2×6 fallback for short terminals (height < 24).
   * Each row stacks 6 panels side-by-side (colW = width / 6).
   */
  private renderAllCompact(width: number, height: number): string {
    const w = Math.max(60, Math.floor(width))
    const colW = Math.max(10, Math.floor(w / 6))
    const rowH = Math.max(5, Math.floor(height / 2))

    const a = this.taskPanel.render(colW, rowH)
    const b = this.beliefPanel.render(colW, rowH)
    const c = this.verificationPanel.render(colW, rowH)
    const d = this.evidencePanel.render(colW, rowH)
    const e = this.tracePanel.render(colW, rowH)
    const f = this.failurePanel.render(colW, rowH)
    const top = joinRowN([a, b, c, d, e, f], colW)

    const g = this.probePanel.render(colW, rowH)
    const h = this.contradictionPanel.render(colW, rowH)
    const i = this.decisionPanel.render(colW, rowH)
    const j = this.checkpointPanel.render(colW, rowH)
    const k = this.prReadinessPanel.render(colW, rowH)
    const l = this.costPanel.render(colW, rowH)
    const bottom = joinRowN([g, h, i, j, k, l], colW)

    return top + '\n' + bottom
  }

  /** Repaint each blessed box with its panel's render() output. */
  refresh(): void {
    if (!this.screen) return
    const boxes = this.boxes
    const w = (boxes.task?.width as number) || 30
    const h = (boxes.task?.height as number) || 10
    for (const [key, panel] of Object.entries(this.panels())) {
      const box = boxes[key]
      if (box) box.setContent(panel.render(w, h))
    }
    this.screen.render?.()
  }

  /** Tear down the blessed screen if mounted. Safe to call when not mounted. */
  destroy(): void {
    if (this.screen?.destroy) this.screen.destroy()
    this.screen = undefined
    this.boxes = {}
  }

  private panels(): Record<string, { render: (w: number, h: number) => string }> {
    return {
      task: this.taskPanel,
      belief: this.beliefPanel,
      verification: this.verificationPanel,
      evidence: this.evidencePanel,
      trace: this.tracePanel,
      failures: this.failurePanel,
      probe: this.probePanel,
      contradiction: this.contradictionPanel,
      decision: this.decisionPanel,
      checkpoint: this.checkpointPanel,
      prReadiness: this.prReadinessPanel,
      cost: this.costPanel,
    }
  }

  private initBlessed(title: string): void {
    this.screen = blessed.screen({ smartCSR: true, title: `${title} Panels Dashboard` })

    const border = { type: 'line' as const }
    const style = { fg: 'white', bg: 'black', border: { fg: 'cyan' } }
    const labelFor = (k: string): string => {
      if (k === 'prReadiness') return ' PR Readiness '
      return ' ' + k.charAt(0).toUpperCase() + k.slice(1) + ' '
    }

    // 3 columns × 4 rows of 25% height each.
    const layout: Array<[string, number, number]> = [
      // row 0
      ['task', 0, 0],
      ['belief', 1, 0],
      ['verification', 2, 0],
      // row 1
      ['evidence', 0, 1],
      ['trace', 1, 1],
      ['failures', 2, 1],
      // row 2
      ['probe', 0, 2],
      ['contradiction', 1, 2],
      ['decision', 2, 2],
      // row 3
      ['checkpoint', 0, 3],
      ['prReadiness', 1, 3],
      ['cost', 2, 3],
    ]
    for (const [key, col, row] of layout) {
      this.boxes[key] = blessed.box({
        parent: this.screen,
        top: `${row * 25}%`,
        left: col === 0 ? 0 : col === 1 ? '33.33%' : '66.66%',
        width: col === 2 ? '33.34%' : '33.33%',
        height: '25%',
        label: labelFor(key),
        border,
        style,
        tags: true,
      })
    }

    // Tab focus moves between panels and routes keys into handleKey.
    for (const key of Object.keys(this.boxes)) {
      const box = this.boxes[key]
      const panel = (this as any)[`${key}Panel`]
      if (panel?.handleKey) {
        box.on('keypress', (ch: string, keyObj: any) => {
          panel.handleKey(keyObj?.full ?? ch)
        })
      }
    }

    this.screen.key(['q', 'C-c'], () => this.destroy())
    this.screen.key(['tab'], () => this.screen.focusNext?.())
    this.refresh()
  }
}

function joinRow(a: string, b: string, c: string, colW: number): string {
  const aRows = a.split('\n')
  const bRows = b.split('\n')
  const cRows = c.split('\n')
  const rowCount = Math.max(aRows.length, bRows.length, cRows.length)
  const out: string[] = []
  for (let i = 0; i < rowCount; i++) {
    out.push(padRow(aRows[i] ?? '', colW) + padRow(bRows[i] ?? '', colW) + padRow(cRows[i] ?? '', colW))
  }
  return out.join('\n')
}

function joinRowN(panels: string[], colW: number): string {
  const allRows = panels.map((p) => p.split('\n'))
  const rowCount = Math.max(...allRows.map((r) => r.length))
  const out: string[] = []
  for (let i = 0; i < rowCount; i++) {
    let line = ''
    for (const rows of allRows) {
      line += padRow(rows[i] ?? '', colW)
    }
    out.push(line)
  }
  return out.join('\n')
}

function padRow(row: string, width: number): string {
  return row.length < width ? row + ' '.repeat(width - row.length) : row.slice(0, width)
}
