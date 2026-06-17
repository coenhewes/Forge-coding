/**
 * FailurePanel — failed attempts + disproven hypotheses.
 *
 * Renders `FailureLedger` entries. Read-only. Groups by status if `disproven`
 * hypotheses are present in the optional second fixture.
 */

import type { FailureEntry, Hypothesis } from '@forge/types'

export interface FailurePanelFixture {
  ledger?: { entries: FailureEntry[] } | FailureEntry[]
  disproven?: Hypothesis[]
}

export class FailurePanel {
  private ledger: FailureEntry[]
  private disproven: Hypothesis[]
  private lastKey = ''

  constructor(fixture: FailurePanelFixture) {
    this.ledger = normaliseLedger(fixture.ledger)
    this.disproven = fixture.disproven ?? []
  }

  setFixture(fixture: FailurePanelFixture): void {
    this.ledger = normaliseLedger(fixture.ledger)
    this.disproven = fixture.disproven ?? []
  }

  render(width: number, height: number): string {
    const w = Math.max(20, Math.floor(width))
    const h = Math.max(5, Math.floor(height))

    const lines: string[] = []
    lines.push(`Failures — ${this.ledger.length} attempts, ${this.disproven.length} disproven hypotheses`)
    lines.push('')

    if (this.ledger.length === 0 && this.disproven.length === 0) {
      lines.push('  (no failures recorded)')
    }

    if (this.ledger.length > 0) {
      lines.push('Recent attempts:')
      const recent = [...this.ledger].sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1)).slice(0, 4)
      for (const f of recent) {
        lines.push(`  [x] ${truncate(f.hypothesis, w - 6)}`)
        lines.push(`      ${truncate(f.action, w - 8)}`)
        lines.push(`      → ${truncate(f.result, w - 10)}`)
        lines.push(`      ! ${truncate(f.lesson, w - 10)}`)
        if (f.nextHypothesis) lines.push(`      → next: ${truncate(f.nextHypothesis, w - 12)}`)
      }
    }

    if (this.disproven.length > 0) {
      lines.push('')
      lines.push('Disproven hypotheses (do NOT retry without new evidence):')
      for (const hyp of this.disproven.slice(0, 4)) {
        lines.push(`  [X] ${truncate(hyp.claim, w - 6)}`)
      }
    }

    const out = lines.slice(0, h)
    return padWidth(out.join('\n'), w)
  }

  handleKey(key: string): void {
    this.lastKey = key
  }

  getLastKey(): string {
    return this.lastKey
  }
}

function normaliseLedger(f: FailurePanelFixture['ledger']): FailureEntry[] {
  if (!f) return []
  return Array.isArray(f) ? f : f.entries ?? []
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