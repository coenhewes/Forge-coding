/**
 * CostPanel — per-stage token + runtime + USD cost breakdown.
 *
 * Each `CostStage` is a stage of the harness loop (e.g. `task_understanding`,
 * `localization`, `patch_search`, `verification`). The panel renders a small
 * table with columns: stage | in_tok | out_tok | runtime_ms | cost_usd.
 *
 * A `CostTotals` row at the bottom sums all stages so the operator can compare
 * against the autonomy-mode budget without scrolling.
 *
 * Read-only. `handleKey` records the last key for tests; 's' toggles sort
 * between stage-name (default) and cost-desc.
 */

export interface CostStage {
  name: string
  inputTokens: number
  outputTokens: number
  runtimeMs: number
  costUsd: number
}

export interface CostTotals {
  inputTokens: number
  outputTokens: number
  runtimeMs: number
  costUsd: number
}

export interface CostPanelFixture {
  stages: CostStage[]
  totals: CostTotals
}

type SortMode = 'name' | 'cost'

export class CostPanel {
  private fixture: CostPanelFixture
  private lastKey = ''
  private sortMode: SortMode = 'name'

  constructor(fixture?: CostPanelFixture) {
    this.fixture = fixture ?? {
      stages: [],
      totals: { inputTokens: 0, outputTokens: 0, runtimeMs: 0, costUsd: 0 },
    }
  }

  setFixture(fixture: CostPanelFixture): void {
    this.fixture = fixture
  }

  render(width: number, height: number): string {
    const w = Math.max(40, Math.floor(width))
    const h = Math.max(5, Math.floor(height))

    const sorted = [...this.fixture.stages].sort((a, b) => {
      if (this.sortMode === 'cost') return b.costUsd - a.costUsd
      return a.name.localeCompare(b.name)
    })

    const lines: string[] = []
    lines.push(`Cost — ${sorted.length} stages  sort: ${this.sortMode}  (press 's' to toggle)`)
    lines.push('')

    // Header
    lines.push(
      '  ' +
        pad('stage', 24) +
        pad('in_tok', 10, true) +
        pad('out_tok', 10, true) +
        pad('runtime_ms', 12, true) +
        pad('cost_usd', 10, true),
    )

    if (sorted.length === 0) {
      lines.push('  (no stages recorded)')
    }

    for (const s of sorted) {
      lines.push(
        '  ' +
          pad(s.name, 24) +
          pad(s.inputTokens.toLocaleString('en-US'), 10, true) +
          pad(s.outputTokens.toLocaleString('en-US'), 10, true) +
          pad(s.runtimeMs.toLocaleString('en-US'), 12, true) +
          pad(s.costUsd.toFixed(4), 10, true),
      )
    }

    lines.push('  ' + '-'.repeat(Math.min(w - 4, 64)))
    const t = this.fixture.totals
    lines.push(
      '  ' +
        pad('TOTAL', 24) +
        pad(t.inputTokens.toLocaleString('en-US'), 10, true) +
        pad(t.outputTokens.toLocaleString('en-US'), 10, true) +
        pad(t.runtimeMs.toLocaleString('en-US'), 12, true) +
        pad(t.costUsd.toFixed(4), 10, true),
    )

    const out = lines.slice(0, h)
    return padWidth(out.join('\n'), w)
  }

  handleKey(key: string): void {
    this.lastKey = key
    if (key === 's') {
      this.sortMode = this.sortMode === 'name' ? 'cost' : 'name'
    }
  }

  getLastKey(): string {
    return this.lastKey
  }

  getSortMode(): SortMode {
    return this.sortMode
  }
}

function pad(text: string, width: number, rightAlign = false): string {
  if (text.length >= width) return text.slice(0, width)
  const padLen = width - text.length
  return rightAlign ? ' '.repeat(padLen) + text : text + ' '.repeat(padLen)
}

function padWidth(text: string, width: number): string {
  return text
    .split('\n')
    .map((line) => (line.length < width ? line + ' '.repeat(width - line.length) : line.slice(0, width)))
    .join('\n')
}
