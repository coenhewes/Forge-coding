/**
 * ProbePanel — ordered list of probe recommendations with priority bars.
 *
 * Fixture field `probes: Probe[]` (panel-local `Probe` type). Each probe
 * targets a claim and has a `priorityScore` (0..1) and an
 * `expectedEvidenceKind`. Blocked probes (e.g. missing permissions or a
 * required capability) are rendered greyed-out at the bottom of the list.
 *
 * Read-only. `handleKey` records the last key for tests; cursor moves on
 * 'j'/'k', expanded-rationale view toggles on Enter/Space; 'd' is a no-op
 * stub for "mark done".
 */

export interface Probe {
  id: string
  claimId: string
  rationale: string
  expectedEvidenceKind: string
  priorityScore: number
  blocked: boolean
}

export interface ProbePanelFixture {
  probes: Probe[]
}

export class ProbePanel {
  private fixture: ProbePanelFixture
  private lastKey = ''
  private cursor = 0
  private expanded = false

  constructor(fixture?: ProbePanelFixture) {
    this.fixture = fixture ?? { probes: [] }
  }

  setFixture(fixture: ProbePanelFixture): void {
    this.fixture = fixture
    if (this.cursor >= this.fixture.probes.length) this.cursor = 0
  }

  render(width: number, height: number): string {
    const w = Math.max(20, Math.floor(width))
    const h = Math.max(5, Math.floor(height))

    const open = this.fixture.probes.filter((p) => !p.blocked)
    const blocked = this.fixture.probes.filter((p) => p.blocked)
    // Stable order: priority desc within each group.
    const sorted = [...open]
      .sort((a, b) => b.priorityScore - a.priorityScore)
      .concat([...blocked].sort((a, b) => b.priorityScore - a.priorityScore))

    const lines: string[] = []
    lines.push(`Probes — ${sorted.length} (${open.length} open, ${blocked.length} blocked)`)
    lines.push('')

    if (sorted.length === 0) {
      lines.push('  (no probes queued) 0 queued')
    }

    for (let i = 0; i < sorted.length; i++) {
      const p = sorted[i]!
      const pct = Math.round(Math.max(0, Math.min(1, p.priorityScore)) * 100)
      const bar = renderBar(pct, Math.max(8, Math.min(24, w - 36)))
      const marker = i === this.cursor ? '▶' : ' '
      const tag = p.blocked ? '[·]' : '[>]'
      const head = `  ${marker}${tag} ${pct.toString().padStart(3)}% ${bar} ${truncate(p.claimId, w - 28)}`
      lines.push(p.blocked ? greyLine(head) : head)
      lines.push(`     kind: ${truncate(p.expectedEvidenceKind, w - 11)}`)
      if (this.expanded || i === this.cursor) {
        lines.push(`     ↳ ${truncate(p.rationale, w - 7)}`)
      }
    }

    const out = lines.slice(0, h)
    return padWidth(out.join('\n'), w)
  }

  handleKey(key: string): void {
    this.lastKey = key
    const total = this.fixture.probes.length
    if (total === 0) return

    if (key === 'j') {
      this.cursor = (this.cursor + 1) % total
    } else if (key === 'k') {
      this.cursor = (this.cursor - 1 + total) % total
    } else if (key === 'enter' || key === ' ') {
      this.expanded = !this.expanded
    }
    // 'd' = mark done (no-op stub: panels are read-only)
  }

  getLastKey(): string {
    return this.lastKey
  }

  getCursor(): number {
    return this.cursor
  }
}

function renderBar(pct: number, width: number): string {
  const filled = Math.round((pct / 100) * width)
  return '[' + '#'.repeat(filled) + '-'.repeat(Math.max(0, width - filled)) + ']'
}

/**
 * Greyed-out visual: collapse the bar's '#' fills to '.' to dim the row.
 * ASCII-only so snapshot tests and headless rendering stay stable.
 */
function greyLine(line: string): string {
  return line.replace(/#/g, '·')
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
