/**
 * DecisionPanel — chronological list of decisions; press 'e' to expand a row.
 *
 * Each `Decision` records: what was decided, why, which alternatives were
 * rejected, and which verification obligations must pass before the decision
 * is trusted. The panel renders a compact single-line summary by default; an
 * expanded row shows the full rationale + rejected alternatives + verification
 * list.
 *
 * Read-only. `handleKey` records the last key for tests; 'j'/'k' move the
 * cursor, 'e' toggles the expansion, 'q'/'escape' collapses.
 */

export interface Decision {
  id: string
  taskId: string
  summary: string
  rationale: string
  alternativesRejected: string[]
  verificationRequired: string[]
  madeAt: string
}

export interface DecisionPanelFixture {
  decisions: Decision[]
}

export class DecisionPanel {
  private fixture: DecisionPanelFixture
  private lastKey = ''
  private cursor = 0
  private expanded = false

  constructor(fixture?: DecisionPanelFixture) {
    this.fixture = fixture ?? { decisions: [] }
  }

  setFixture(fixture: DecisionPanelFixture): void {
    this.fixture = fixture
    if (this.cursor >= this.fixture.decisions.length) this.cursor = 0
  }

  render(width: number, height: number): string {
    const w = Math.max(20, Math.floor(width))
    const h = Math.max(5, Math.floor(height))

    const sorted = [...this.fixture.decisions].sort((a, b) => (a.madeAt < b.madeAt ? -1 : 1))

    const lines: string[] = []
    lines.push(`Decisions — ${sorted.length} (cursor ${this.cursor + 1}/${Math.max(1, sorted.length)})`)
    lines.push('')

    if (sorted.length === 0) {
      lines.push('  (no decisions recorded) 0 on file')
    }

    for (let i = 0; i < sorted.length; i++) {
      const d = sorted[i]!
      const marker = i === this.cursor ? '▶' : ' '
      const when = shortTime(d.madeAt)
      const head = `  ${marker}${when}  ${truncate(d.summary, w - 16)}`
      lines.push(head)
      lines.push(`     task: ${truncate(d.taskId, w - 11)}  verify: ${d.verificationRequired.length} required`)

      if (this.expanded && i === this.cursor) {
        lines.push('')
        lines.push(`     ↳ ${truncate(d.rationale, w - 7)}`)
        if (d.alternativesRejected.length > 0) {
          lines.push('     rejected alternatives:')
          for (const alt of d.alternativesRejected.slice(0, 4)) {
            lines.push(`       - ${truncate(alt, w - 9)}`)
          }
        }
        if (d.verificationRequired.length > 0) {
          lines.push('     verification obligations:')
          for (const v of d.verificationRequired.slice(0, 4)) {
            lines.push(`       · ${truncate(v, w - 9)}`)
          }
        }
      }
    }

    const out = lines.slice(0, h)
    return padWidth(out.join('\n'), w)
  }

  handleKey(key: string): void {
    this.lastKey = key
    const total = this.fixture.decisions.length
    if (total === 0) return

    if (key === 'j') {
      this.cursor = (this.cursor + 1) % total
    } else if (key === 'k') {
      this.cursor = (this.cursor - 1 + total) % total
    } else if (key === 'e') {
      this.expanded = !this.expanded
    } else if (key === 'escape' || key === 'q') {
      this.expanded = false
    }
  }

  getLastKey(): string {
    return this.lastKey
  }

  getCursor(): number {
    return this.cursor
  }

  isExpanded(): boolean {
    return this.expanded
  }
}

function shortTime(ts: string): string {
  if (!ts) return '--:--:--'
  const tIdx = ts.indexOf('T')
  if (tIdx >= 0) return ts.slice(tIdx + 1, tIdx + 9) || ts.slice(-8)
  return ts.slice(-8)
}

function truncate(text: string, width: number): string {
  if (width <= 0) return ''
  return text.length <= width ? text : text.slice(0, Math.max(0, width - 1)) + '…'
}

function padWidth(text: string, width: number): string {
  return text
    .split('\n')
    .map((line) => (line.length < width ? line + ' '.repeat(width - line.length) : line.slice(0, width)))
    .join('\n')
}
