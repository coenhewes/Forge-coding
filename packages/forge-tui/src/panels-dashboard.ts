/**
 * PanelsDashboard — 3×2 grid host that wires the 6 read-only panels together.
 *
 * Layout:
 *
 *   ┌──────────────┬──────────────┬──────────────┐
 *   │   Task       │   Belief     │   Verify     │
 *   ├──────────────┼──────────────┼──────────────┤
 *   │   Evidence   │   Trace      │   Failures   │
 *   └──────────────┴──────────────┴──────────────┘
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

export interface PanelsDashboardFixtures {
  task: TaskPanelFixture
  belief: BeliefPanelFixture
  verification: VerificationPanelFixture
  evidence: EvidencePanelFixture
  trace: TracePanelFixture
  failures: FailurePanelFixture
}

export interface PanelsDashboardOptions {
  fixtures: PanelsDashboardFixtures
  /** If true (default), instantiate blessed widgets. Pass false for headless tests. */
  useBlessed?: boolean
  /** Optional title for the host screen. */
  title?: string
}

/**
 * The dashboard host. Holds all 6 panels, manages the blessed grid, and exposes
 * a `renderAll(width, height)` for headless callers.
 */
export class PanelsDashboard {
  readonly taskPanel: TaskPanel
  readonly beliefPanel: BeliefPanel
  readonly verificationPanel: VerificationPanel
  readonly evidencePanel: EvidencePanel
  readonly tracePanel: TracePanel
  readonly failurePanel: FailurePanel

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
    this.refresh()
  }

  /** Headless render — returns the 6 panels joined into one text block. */
  renderAll(width = 80, height = 24): string {
    const colW = Math.max(20, Math.floor(width / 3))
    const rowH = Math.max(5, Math.floor(height / 2))
    const task = this.taskPanel.render(colW, rowH)
    const belief = this.beliefPanel.render(colW, rowH)
    const verify = this.verificationPanel.render(colW, rowH)
    const evidence = this.evidencePanel.render(colW, rowH)
    const trace = this.tracePanel.render(colW, rowH)
    const failures = this.failurePanel.render(colW, rowH)
    return joinRows(
      joinRow(task, belief, verify, colW),
      joinRow(evidence, trace, failures, colW)
    )
  }

  /** Repaint each blessed box with its panel's render() output. */
  refresh(): void {
    if (!this.screen) return
    const boxes = this.boxes
    const w = (boxes.task?.width as number) || 30
    const h = (boxes.task?.height as number) || 10
    if (boxes.task) boxes.task.setContent(this.taskPanel.render(w, h))
    if (boxes.belief) boxes.belief.setContent(this.beliefPanel.render(w, h))
    if (boxes.verification) boxes.verification.setContent(this.verificationPanel.render(w, h))
    if (boxes.evidence) boxes.evidence.setContent(this.evidencePanel.render(w, h))
    if (boxes.trace) boxes.trace.setContent(this.tracePanel.render(w, h))
    if (boxes.failures) boxes.failures.setContent(this.failurePanel.render(w, h))
    this.screen.render?.()
  }

  /** Tear down the blessed screen if mounted. Safe to call when not mounted. */
  destroy(): void {
    if (this.screen?.destroy) this.screen.destroy()
    this.screen = undefined
    this.boxes = {}
  }

  private initBlessed(title: string): void {
    this.screen = blessed.screen({ smartCSR: true, title: `${title} Panels Dashboard` })

    const border = { type: 'line' as const }
    const style = { fg: 'white', bg: 'black', border: { fg: 'cyan' } }

    this.boxes.task = blessed.box({
      parent: this.screen,
      top: 0, left: 0, width: '33.33%', height: '50%',
      label: ' Task ', border, style, tags: true,
    })
    this.boxes.belief = blessed.box({
      parent: this.screen,
      top: 0, left: '33.33%', width: '33.33%', height: '50%',
      label: ' Belief ', border, style, tags: true,
    })
    this.boxes.verification = blessed.box({
      parent: this.screen,
      top: 0, left: '66.66%', width: '33.34%', height: '50%',
      label: ' Verification ', border, style, tags: true,
    })
    this.boxes.evidence = blessed.box({
      parent: this.screen,
      top: '50%', left: 0, width: '33.33%', height: '50%',
      label: ' Evidence ', border, style, tags: true,
    })
    this.boxes.trace = blessed.box({
      parent: this.screen,
      top: '50%', left: '33.33%', width: '33.33%', height: '50%',
      label: ' Trace ', border, style, tags: true,
    })
    this.boxes.failures = blessed.box({
      parent: this.screen,
      top: '50%', left: '66.66%', width: '33.34%', height: '50%',
      label: ' Failures ', border, style, tags: true,
    })

    // Tab focus moves between panels and routes keys into handleKey.
    for (const key of ['task', 'belief', 'verification', 'evidence', 'trace', 'failures'] as const) {
      const box = this.boxes[key]
      const panel = (this as any)[`${key}Panel`]
      box.on('keypress', (ch: string, keyObj: any) => {
        panel.handleKey(keyObj?.full ?? ch)
      })
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

function joinRows(top: string, bottom: string): string {
  return top + '\n' + bottom
}

function padRow(row: string, width: number): string {
  return row.length < width ? row + ' '.repeat(width - row.length) : row.slice(0, width)
}